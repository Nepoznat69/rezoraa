import { config } from '../config.js';

type Level = 'debug' | 'info' | 'warn' | 'error';

const priorities: Record<Level, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

function write(level: Level, message: string, context: Record<string, unknown> = {}): void {
  if (priorities[level] < priorities[config.LOG_LEVEL]) return;

  const line = JSON.stringify({
    vrijeme: new Date().toISOString(),
    nivo: level,
    poruka: message,
    ...context,
  });

  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
}

export const logger = {
  debug: (message: string, context?: Record<string, unknown>) => write('debug', message, context),
  info: (message: string, context?: Record<string, unknown>) => write('info', message, context),
  warn: (message: string, context?: Record<string, unknown>) => write('warn', message, context),
  error: (message: string, context?: Record<string, unknown>) => write('error', message, context),
};

export function maskPhone(phone: string): string {
  const visible = phone.replace(/\D/g, '').slice(-4);
  return visible ? `***${visible}` : '***';
}

