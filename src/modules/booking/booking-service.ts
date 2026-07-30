import { randomBytes } from 'node:crypto';
import { DateTime } from 'luxon';
import type { PoolClient } from 'pg';
import type { AiExtraction, ServiceDefinition, TenantContext } from '../../domain/schemas.js';
import type { ResolvedInterval } from '../../domain/date-resolver.js';
import { withTransaction } from '../../infrastructure/database.js';

interface AllocationPlan {
  employeeId: string | null;
  employeeName: string;
  resourceId: string | null;
  resourceName: string;
  resourceExclusive: boolean;
  quantity: number;
}

export interface BookingOperationResult {
  ok: boolean;
  available?: boolean;
  reply: string;
  bookingCode?: string;
  status?: string;
}

interface BookingCommand {
  tenant: TenantContext;
  customerId: string;
  service: ServiceDefinition;
  extraction: AiExtraction;
  interval: ResolvedInterval;
  idempotencyKey: string;
}

class BookingConflictError extends Error {}

function bookingCode(): string {
  const date = DateTime.utc().toFormat('yyLLdd');
  return `RZ-${date}-${randomBytes(3).toString('hex').toUpperCase()}`;
}

async function setTenant(client: PoolClient, tenantId: string): Promise<void> {
  await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
}

export class BookingService {
  private allocationWindow(command: BookingCommand): { startsAt: Date; endsAt: Date } {
    return {
      startsAt: DateTime.fromJSDate(command.interval.startsAt)
        .minus({ minutes: command.service.bufferBeforeMinutes })
        .toJSDate(),
      endsAt: DateTime.fromJSDate(command.interval.endsAt)
        .plus({ minutes: command.service.bufferAfterMinutes })
        .toJSDate(),
    };
  }

  private validateAdvancePolicy(command: BookingCommand): void {
    const now = DateTime.utc();
    const start = DateTime.fromJSDate(command.interval.startsAt, { zone: 'utc' });
    const min = Number(command.tenant.bookingPolicy.min_advance_minutes ?? 0);
    const maxDays = Number(command.tenant.bookingPolicy.max_advance_days ?? 365);
    if (start < now.plus({ minutes: min })) {
      throw new BookingConflictError('Termin je preblizu ili je već prošao.');
    }
    if (start > now.plus({ days: maxDays })) {
      throw new BookingConflictError('Termin je izvan dozvoljenog perioda za rezervaciju.');
    }
  }

  private async assertBusinessHours(client: PoolClient, command: BookingCommand): Promise<void> {
    if (command.service.bookingModel === 'accommodation') return;
    const start = DateTime.fromJSDate(command.interval.startsAt, { zone: command.tenant.timezone });
    const end = DateTime.fromJSDate(command.interval.endsAt, { zone: command.tenant.timezone });
    const rows = await client.query(
      `SELECT 1 FROM business_hours
        WHERE tenant_id = $1 AND active = true AND weekday = $2
          AND employee_id IS NULL AND resource_id IS NULL
          AND ($3::uuid IS NULL OR location_id IS NULL OR location_id = $3)
          AND opens_at <= $4::time AND closes_at >= $5::time
        LIMIT 1`,
      [
        command.tenant.tenantId,
        start.weekday,
        command.service.locationId,
        start.toFormat('HH:mm:ss'),
        end.toFormat('HH:mm:ss'),
      ],
    );
    if (!rows.rowCount) throw new BookingConflictError('Traženi termin je izvan radnog vremena.');
  }

  private async hasClosedException(
    client: PoolClient,
    command: BookingCommand,
    employeeId: string | null,
    resourceId: string | null,
  ): Promise<boolean> {
    const rows = await client.query(
      `SELECT 1 FROM calendar_exceptions
        WHERE tenant_id = $1 AND closed = true
          AND starts_at < $3 AND ends_at > $2
          AND (location_id IS NULL OR location_id = $4)
          AND (employee_id IS NULL OR employee_id = $5)
          AND (resource_id IS NULL OR resource_id = $6)
        LIMIT 1`,
      [
        command.tenant.tenantId,
        command.interval.startsAt,
        command.interval.endsAt,
        command.service.locationId,
        employeeId,
        resourceId,
      ],
    );
    return Boolean(rows.rowCount);
  }

  private async findEmployee(client: PoolClient, command: BookingCommand): Promise<{ id: string; name: string } | null> {
    if (!command.service.requiresEmployee) return null;
    const requested = command.extraction.employee.trim();
    const window = this.allocationWindow(command);
    const candidates = await client.query<{ id: string; name: string }>(
      `SELECT employee.id, employee.name
         FROM employees employee
         JOIN service_employees mapping ON mapping.employee_id = employee.id
        WHERE employee.tenant_id = $1 AND mapping.service_id = $2 AND employee.active = true
          AND ($3 = '' OR lower(employee.name) = lower($3))
        ORDER BY CASE WHEN $3 <> '' AND lower(employee.name) = lower($3) THEN 0 ELSE mapping.priority END,
                 employee.name
        FOR UPDATE OF employee`,
      [command.tenant.tenantId, command.service.id, requested],
    );
    for (const employee of candidates.rows) {
      const busy = await client.query(
        `SELECT 1 FROM booking_allocations
          WHERE tenant_id = $1 AND allocatable_type = 'employee' AND allocatable_id = $2
            AND active = true AND starts_at < $4 AND ends_at > $3 LIMIT 1`,
        [command.tenant.tenantId, employee.id, window.startsAt, window.endsAt],
      );
      if (!busy.rowCount) return employee;
    }
    throw new BookingConflictError(
      requested ? 'Odabrani zaposlenik nije dostupan u traženom terminu.' : 'Nijedan odgovarajući zaposlenik nije slobodan.',
    );
  }

  private async findResource(
    client: PoolClient,
    command: BookingCommand,
  ): Promise<{ id: string; name: string; capacity: number; exclusive: boolean } | null> {
    if (!command.service.requiresResource) return null;
    const requested = (command.extraction.resource || command.extraction.room_type).trim();
    const window = this.allocationWindow(command);
    const candidates = await client.query<{
      id: string;
      name: string;
      capacity: number;
      exclusive: boolean;
    }>(
      `SELECT resource.id, resource.name, resource.capacity, resource.exclusive
         FROM resources resource
         JOIN service_resources mapping ON mapping.resource_id = resource.id
        WHERE resource.tenant_id = $1 AND mapping.service_id = $2 AND resource.active = true
          AND ($3 = '' OR lower(resource.name) = lower($3) OR lower(resource.resource_type) = lower($3))
        ORDER BY CASE WHEN $3 <> '' AND lower(resource.name) = lower($3) THEN 0 ELSE mapping.priority END,
                 resource.name
        FOR UPDATE OF resource`,
      [command.tenant.tenantId, command.service.id, requested],
    );
    const requestedQuantity = Math.max(1, command.extraction.quantity || command.extraction.party_size || 1);
    for (const resource of candidates.rows) {
      const used = await client.query<{ used: string }>(
        `SELECT coalesce(sum(quantity), 0)::text AS used
           FROM booking_allocations
          WHERE tenant_id = $1 AND allocatable_type = 'resource' AND allocatable_id = $2
            AND active = true AND starts_at < $4 AND ends_at > $3`,
        [command.tenant.tenantId, resource.id, window.startsAt, window.endsAt],
      );
      const current = Number(used.rows[0]?.used ?? 0);
      if (resource.exclusive ? current === 0 : current + requestedQuantity <= resource.capacity) {
        return resource;
      }
    }
    throw new BookingConflictError(
      requested ? 'Odabrani resurs nije dostupan u traženom terminu.' : 'Nijedan odgovarajući resurs nije slobodan.',
    );
  }

  private async allocationPlan(client: PoolClient, command: BookingCommand): Promise<AllocationPlan> {
    this.validateAdvancePolicy(command);
    await this.assertBusinessHours(client, command);
    const employee = await this.findEmployee(client, command);
    const resource = await this.findResource(client, command);
    if (await this.hasClosedException(client, command, employee?.id ?? null, resource?.id ?? null)) {
      throw new BookingConflictError('Traženi termin nije dostupan zbog izuzetka u kalendaru.');
    }
    return {
      employeeId: employee?.id ?? null,
      employeeName: employee?.name ?? '',
      resourceId: resource?.id ?? null,
      resourceName: resource?.name ?? '',
      resourceExclusive: resource?.exclusive ?? true,
      quantity: Math.max(1, command.extraction.quantity || command.extraction.party_size || 1),
    };
  }

  async checkAvailability(command: BookingCommand): Promise<BookingOperationResult> {
    try {
      const plan = await withTransaction(async (client) => {
        await setTenant(client, command.tenant.tenantId);
        return this.allocationPlan(client, command);
      });
      const detail = [plan.employeeName, plan.resourceName].filter(Boolean).join(', ');
      return {
        ok: true,
        available: true,
        reply: `Traženi termin je trenutno dostupan${detail ? ` (${detail})` : ''}. Želite li da napravim rezervaciju?`,
      };
    } catch (error) {
      if (error instanceof BookingConflictError) {
        return { ok: true, available: false, reply: error.message };
      }
      throw error;
    }
  }

  async createBooking(command: BookingCommand): Promise<BookingOperationResult> {
    try {
      return await withTransaction(async (client) => {
        await setTenant(client, command.tenant.tenantId);
        const existing = await client.query<{ booking_code: string; status: string }>(
          `SELECT booking.booking_code, booking.status
             FROM booking_events event
             JOIN bookings booking ON booking.id = event.booking_id
            WHERE event.tenant_id = $1 AND event.idempotency_key = $2 LIMIT 1`,
          [command.tenant.tenantId, command.idempotencyKey],
        );
        if (existing.rowCount) {
          return {
            ok: true,
            bookingCode: existing.rows[0].booking_code,
            status: existing.rows[0].status,
            reply: `Zahtjev je već obrađen. Broj rezervacije je ${existing.rows[0].booking_code}.`,
          };
        }

        const plan = await this.allocationPlan(client, command);
        const autoConfirm = command.tenant.bookingPolicy.auto_confirm === true;
        const status = autoConfirm ? 'confirmed' : 'held';
        const holdMinutes = Number(command.tenant.bookingPolicy.hold_minutes ?? 10);
        const code = bookingCode();
        const inserted = await client.query<{ id: string }>(
          `INSERT INTO bookings (
             tenant_id, booking_code, customer_id, service_id, location_id, starts_at, ends_at,
             timezone, status, party_size, quantity, notes, hold_expires_at
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12,
             CASE WHEN $9 = 'held' THEN now() + make_interval(mins => $13) ELSE NULL END)
           RETURNING id`,
          [
            command.tenant.tenantId,
            code,
            command.customerId,
            command.service.id,
            command.service.locationId,
            command.interval.startsAt,
            command.interval.endsAt,
            command.tenant.timezone,
            status,
            Math.max(1, command.extraction.party_size || 1),
            Math.max(1, command.extraction.quantity || 1),
            command.extraction.notes,
            holdMinutes,
          ],
        );
        const bookingId = inserted.rows[0].id;
        await this.insertAllocations(client, command, plan, bookingId);
        await client.query(
          `INSERT INTO booking_events (
             tenant_id, booking_id, event_type, actor_type, idempotency_key, new_values
           ) VALUES ($1, $2, 'booking_created', 'customer', $3, $4)`,
          [command.tenant.tenantId, bookingId, command.idempotencyKey, { status }],
        );

        return {
          ok: true,
          bookingCode: code,
          status,
          reply: autoConfirm
            ? `Rezervacija je potvrđena. Broj rezervacije je ${code}.`
            : `Termin je privremeno sačuvan. Broj rezervacije je ${code}. Potrebna je potvrda prije isteka holda.`,
        };
      });
    } catch (error) {
      if (error instanceof BookingConflictError || (typeof error === 'object' && error && 'code' in error && error.code === '23P01')) {
        return { ok: true, available: false, reply: error instanceof Error ? error.message : 'Termin je upravo zauzet.' };
      }
      throw error;
    }
  }

  private async insertAllocations(
    client: PoolClient,
    command: BookingCommand,
    plan: AllocationPlan,
    bookingId: string,
  ): Promise<void> {
    const { startsAt, endsAt } = this.allocationWindow(command);
    if (plan.employeeId) {
      await client.query(
        `INSERT INTO booking_allocations (
           tenant_id, booking_id, allocatable_type, allocatable_id, starts_at, ends_at, quantity, exclusive
         ) VALUES ($1, $2, 'employee', $3, $4, $5, 1, true)`,
        [command.tenant.tenantId, bookingId, plan.employeeId, startsAt, endsAt],
      );
    }
    if (plan.resourceId) {
      await client.query(
        `INSERT INTO booking_allocations (
           tenant_id, booking_id, allocatable_type, allocatable_id, starts_at, ends_at, quantity, exclusive
         ) VALUES ($1, $2, 'resource', $3, $4, $5, $6, $7)`,
        [
          command.tenant.tenantId,
          bookingId,
          plan.resourceId,
          startsAt,
          endsAt,
          plan.quantity,
          plan.resourceExclusive,
        ],
      );
    }
  }

  private async findBooking(
    client: PoolClient,
    tenantId: string,
    customerId: string,
    reference: string,
  ): Promise<{ id: string; booking_code: string; starts_at: Date; status: string; service_id: string } | null> {
    const result = await client.query<{
      id: string;
      booking_code: string;
      starts_at: Date;
      status: string;
      service_id: string;
    }>(
      `SELECT id, booking_code, starts_at, status, service_id FROM bookings
        WHERE tenant_id = $1 AND customer_id = $2
          AND status IN ('held', 'pending', 'pending_approval', 'confirmed')
          AND ($3 = '' OR booking_code = upper($3) OR id::text = $3)
        ORDER BY starts_at ASC LIMIT 1 FOR UPDATE`,
      [tenantId, customerId, reference],
    );
    return result.rows[0] ?? null;
  }

  async lookupActiveBooking(
    tenantId: string,
    customerId: string,
    reference: string,
  ): Promise<{ bookingCode: string; serviceId: string; status: string } | null> {
    return withTransaction(async (client) => {
      await setTenant(client, tenantId);
      const booking = await this.findBooking(client, tenantId, customerId, reference);
      return booking
        ? { bookingCode: booking.booking_code, serviceId: booking.service_id, status: booking.status }
        : null;
    });
  }

  async rescheduleBooking(command: BookingCommand): Promise<BookingOperationResult> {
    try {
      return await withTransaction(async (client) => {
        await setTenant(client, command.tenant.tenantId);
        const oldBooking = await this.findBooking(
          client,
          command.tenant.tenantId,
          command.customerId,
          command.extraction.booking_id,
        );
        if (!oldBooking) {
          return { ok: true, reply: 'Nisam pronašao aktivnu rezervaciju koju je moguće pomjeriti.' };
        }

        const priorEvent = await client.query<{ booking_code: string }>(
          `SELECT booking.booking_code
             FROM booking_events event
             JOIN bookings booking ON booking.id = event.booking_id
            WHERE event.tenant_id = $1 AND event.idempotency_key = $2 LIMIT 1`,
          [command.tenant.tenantId, command.idempotencyKey],
        );
        if (priorEvent.rowCount) {
          return {
            ok: true,
            bookingCode: priorEvent.rows[0].booking_code,
            reply: `Zahtjev je već obrađen. Nova rezervacija je ${priorEvent.rows[0].booking_code}.`,
          };
        }

        await client.query(
          `UPDATE booking_allocations SET active = false
            WHERE tenant_id = $1 AND booking_id = $2`,
          [command.tenant.tenantId, oldBooking.id],
        );

        const plan = await this.allocationPlan(client, command);
        const autoConfirm = command.tenant.bookingPolicy.auto_confirm === true;
        const status = autoConfirm ? 'confirmed' : 'held';
        const holdMinutes = Number(command.tenant.bookingPolicy.hold_minutes ?? 10);
        const newCode = bookingCode();
        const inserted = await client.query<{ id: string }>(
          `INSERT INTO bookings (
             tenant_id, booking_code, customer_id, service_id, location_id, starts_at, ends_at,
             timezone, status, party_size, quantity, notes, hold_expires_at, predecessor_booking_id
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12,
             CASE WHEN $9 = 'held' THEN now() + make_interval(mins => $13) ELSE NULL END, $14)
           RETURNING id`,
          [
            command.tenant.tenantId,
            newCode,
            command.customerId,
            command.service.id,
            command.service.locationId,
            command.interval.startsAt,
            command.interval.endsAt,
            command.tenant.timezone,
            status,
            Math.max(1, command.extraction.party_size || 1),
            Math.max(1, command.extraction.quantity || 1),
            command.extraction.notes,
            holdMinutes,
            oldBooking.id,
          ],
        );
        const newBookingId = inserted.rows[0].id;
        await this.insertAllocations(client, command, plan, newBookingId);
        await client.query(
          `UPDATE bookings SET status = 'rescheduled', updated_at = now(), version = version + 1
            WHERE tenant_id = $1 AND id = $2`,
          [command.tenant.tenantId, oldBooking.id],
        );
        await client.query(
          `INSERT INTO booking_events (
             tenant_id, booking_id, event_type, actor_type, idempotency_key, old_values, new_values
           ) VALUES ($1, $2, 'booking_rescheduled', 'customer', $3, $4, $5)`,
          [
            command.tenant.tenantId,
            newBookingId,
            command.idempotencyKey,
            { predecessor_booking_code: oldBooking.booking_code },
            { booking_code: newCode, status },
          ],
        );
        return {
          ok: true,
          bookingCode: newCode,
          status,
          reply: autoConfirm
            ? `Rezervacija ${oldBooking.booking_code} je pomjerena. Novi broj rezervacije je ${newCode}.`
            : `Novi termin je privremeno sačuvan pod brojem ${newCode} i čeka potvrdu.`,
        };
      });
    } catch (error) {
      if (error instanceof BookingConflictError || (typeof error === 'object' && error && 'code' in error && error.code === '23P01')) {
        return { ok: true, available: false, reply: error instanceof Error ? error.message : 'Novi termin je upravo zauzet.' };
      }
      throw error;
    }
  }

  async cancelBooking(
    tenant: TenantContext,
    customerId: string,
    reference: string,
    idempotencyKey: string,
  ): Promise<BookingOperationResult> {
    return withTransaction(async (client) => {
      await setTenant(client, tenant.tenantId);
      const booking = await this.findBooking(client, tenant.tenantId, customerId, reference);
      if (!booking) return { ok: true, reply: 'Nisam pronašao aktivnu rezervaciju za otkazivanje.' };
      const notice = Number(tenant.bookingPolicy.cancellation_notice_minutes ?? 0);
      if (DateTime.fromJSDate(booking.starts_at) < DateTime.utc().plus({ minutes: notice })) {
        return { ok: true, reply: 'Rezervaciju više nije moguće automatski otkazati. Povezat ću vas sa zaposlenikom.' };
      }
      await client.query(
        `UPDATE bookings SET status = 'cancelled', updated_at = now(), version = version + 1
          WHERE tenant_id = $1 AND id = $2`,
        [tenant.tenantId, booking.id],
      );
      await client.query(
        `UPDATE booking_allocations SET active = false WHERE tenant_id = $1 AND booking_id = $2`,
        [tenant.tenantId, booking.id],
      );
      await client.query(
        `INSERT INTO booking_events (tenant_id, booking_id, event_type, actor_type, idempotency_key)
         VALUES ($1, $2, 'booking_cancelled', 'customer', $3) ON CONFLICT DO NOTHING`,
        [tenant.tenantId, booking.id, idempotencyKey],
      );
      return { ok: true, bookingCode: booking.booking_code, status: 'cancelled', reply: `Rezervacija ${booking.booking_code} je otkazana.` };
    });
  }

  async confirmBooking(
    tenant: TenantContext,
    customerId: string,
    reference: string,
    idempotencyKey: string,
  ): Promise<BookingOperationResult> {
    return withTransaction(async (client) => {
      await setTenant(client, tenant.tenantId);
      const booking = await this.findBooking(client, tenant.tenantId, customerId, reference);
      if (!booking) return { ok: true, reply: 'Nisam pronašao rezervaciju koju je moguće potvrditi.' };
      if (booking.status === 'confirmed') {
        return { ok: true, bookingCode: booking.booking_code, status: 'confirmed', reply: `Rezervacija ${booking.booking_code} je već potvrđena.` };
      }
      await client.query(
        `UPDATE bookings SET status = 'confirmed', hold_expires_at = NULL, updated_at = now(), version = version + 1
          WHERE tenant_id = $1 AND id = $2`,
        [tenant.tenantId, booking.id],
      );
      await client.query(
        `INSERT INTO booking_events (tenant_id, booking_id, event_type, actor_type, idempotency_key)
         VALUES ($1, $2, 'booking_confirmed', 'customer', $3) ON CONFLICT DO NOTHING`,
        [tenant.tenantId, booking.id, idempotencyKey],
      );
      return { ok: true, bookingCode: booking.booking_code, status: 'confirmed', reply: `Rezervacija ${booking.booking_code} je potvrđena.` };
    });
  }

  async expireHolds(): Promise<number> {
    return withTransaction(async (client) => {
      const result = await client.query<{ count: number }>('SELECT expire_booking_holds() AS count');
      return Number(result.rows[0]?.count ?? 0);
    });
  }
}
