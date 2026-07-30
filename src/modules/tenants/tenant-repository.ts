import { query } from '../../infrastructure/database.js';
import type { ServiceDefinition, TenantContext } from '../../domain/schemas.js';

interface TenantRow {
  id: string;
  name: string;
  business_type: string;
  timezone: string;
  default_language: string;
  auto_confirm: boolean;
  hold_minutes: number;
  min_advance_minutes: number;
  max_advance_days: number;
  cancellation_notice_minutes: number;
  required_fields: string[];
  require_employee_selection: boolean;
  require_resource_selection: boolean;
  policy_configuration: Record<string, unknown>;
}

interface ServiceRow {
  id: string;
  tenant_id: string;
  location_id: string | null;
  name: string;
  booking_model: ServiceDefinition['bookingModel'];
  default_duration_minutes: number;
  buffer_before_minutes: number;
  buffer_after_minutes: number;
  requires_employee: boolean;
  requires_resource: boolean;
  capacity_mode: ServiceDefinition['capacityMode'];
  configuration: Record<string, unknown>;
}

export class TenantRepository {
  async getContext(tenantId: string): Promise<TenantContext> {
    const [tenantRows, serviceRows, employees, resources, knowledge] = await Promise.all([
      query<TenantRow>(
        `SELECT tenant.id, tenant.name, tenant.business_type, tenant.timezone,
                tenant.default_language, policy.auto_confirm, policy.hold_minutes,
                policy.min_advance_minutes, policy.max_advance_days,
                policy.cancellation_notice_minutes, policy.required_fields,
                policy.require_employee_selection, policy.require_resource_selection,
                policy.configuration AS policy_configuration
           FROM tenants tenant
           JOIN booking_policies policy ON policy.tenant_id = tenant.id
          WHERE tenant.id = $1 AND tenant.status = 'active'`,
        [tenantId],
      ),
      query<ServiceRow>(
        `SELECT id, tenant_id, location_id, name, booking_model, default_duration_minutes,
                buffer_before_minutes, buffer_after_minutes,
                requires_employee, requires_resource, capacity_mode, configuration
           FROM services
          WHERE tenant_id = $1 AND active = true
          ORDER BY name`,
        [tenantId],
      ),
      query<{ id: string; name: string }>(
        'SELECT id, name FROM employees WHERE tenant_id = $1 AND active = true ORDER BY name',
        [tenantId],
      ),
      query<{ id: string; name: string; resource_type: string; capacity: number }>(
        `SELECT id, name, resource_type, capacity
           FROM resources WHERE tenant_id = $1 AND active = true ORDER BY name`,
        [tenantId],
      ),
      query<{ question: string; answer: string }>(
        `SELECT question, answer FROM knowledge_items
          WHERE tenant_id = $1 AND active = true ORDER BY created_at LIMIT 50`,
        [tenantId],
      ),
    ]);

    const tenant = tenantRows[0];
    if (!tenant) throw new Error('Biznis nije pronađen ili nije aktivan.');

    return {
      tenantId: tenant.id,
      businessName: tenant.name,
      businessType: tenant.business_type,
      timezone: tenant.timezone,
      language: tenant.default_language,
      bookingPolicy: {
        auto_confirm: tenant.auto_confirm,
        hold_minutes: tenant.hold_minutes,
        min_advance_minutes: tenant.min_advance_minutes,
        max_advance_days: tenant.max_advance_days,
        cancellation_notice_minutes: tenant.cancellation_notice_minutes,
        required_fields: tenant.required_fields,
        require_employee_selection: tenant.require_employee_selection,
        require_resource_selection: tenant.require_resource_selection,
        ...tenant.policy_configuration,
      },
      services: serviceRows.map((service) => ({
        id: service.id,
        name: service.name,
        bookingModel: service.booking_model,
        defaultDurationMinutes: service.default_duration_minutes,
        bufferBeforeMinutes: service.buffer_before_minutes,
        bufferAfterMinutes: service.buffer_after_minutes,
        requiresEmployee: service.requires_employee,
        requiresResource: service.requires_resource,
        capacityMode: service.capacity_mode,
        configuration: service.configuration,
      })),
      employees,
      resources: resources.map((resource) => ({
        id: resource.id,
        name: resource.name,
        type: resource.resource_type,
        capacity: resource.capacity,
      })),
      knowledge,
    };
  }

  async getService(tenantId: string, serviceId: string): Promise<ServiceDefinition> {
    const rows = await query<ServiceRow>(
      `SELECT id, tenant_id, location_id, name, booking_model, default_duration_minutes,
              buffer_before_minutes, buffer_after_minutes,
              requires_employee, requires_resource, capacity_mode, configuration
         FROM services WHERE tenant_id = $1 AND id = $2 AND active = true`,
      [tenantId, serviceId],
    );
    const row = rows[0];
    if (!row) throw new Error('Usluga nije pronađena.');
    return {
      id: row.id,
      tenantId: row.tenant_id,
      locationId: row.location_id,
      name: row.name,
      bookingModel: row.booking_model,
      defaultDurationMinutes: row.default_duration_minutes,
      bufferBeforeMinutes: row.buffer_before_minutes,
      bufferAfterMinutes: row.buffer_after_minutes,
      requiresEmployee: row.requires_employee,
      requiresResource: row.requires_resource,
      capacityMode: row.capacity_mode,
      configuration: row.configuration,
    };
  }
}
