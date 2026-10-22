// Every container the manager authors keeps its json-file log bounded, so a chatty or flooded service cannot fill
// the host disk.
export const LOG_MAX_SIZE = '10m';
export const LOG_MAX_FILE = '3';

export function cappedLogging(): { driver: string; options: Record<string, string> } {
  return { driver: 'json-file', options: { 'max-size': LOG_MAX_SIZE, 'max-file': LOG_MAX_FILE } };
}

export const LOG_CAP_RUN_ARGS: readonly string[] = [
  '--log-driver', 'json-file', '--log-opt', `max-size=${LOG_MAX_SIZE}`, '--log-opt', `max-file=${LOG_MAX_FILE}`,
];

// A service that names another log driver keeps it (the bot author chose it); a json-file log without a size cap
// gets one, and a cap the author set is kept.
export function capServiceLogs(services: Record<string, Record<string, unknown>>): void {
  for (const service of Object.values(services)) {
    if (!service || typeof service !== 'object') continue;
    const logging = service.logging;
    if (!logging || typeof logging !== 'object') {
      service.logging = cappedLogging();
      continue;
    }
    const current = logging as { driver?: unknown; options?: unknown };
    if (current.driver !== undefined && current.driver !== 'json-file') continue;
    const options = current.options && typeof current.options === 'object' ? current.options as Record<string, unknown> : {};
    if (options['max-size'] === undefined) {
      options['max-size'] = LOG_MAX_SIZE;
      if (options['max-file'] === undefined) options['max-file'] = LOG_MAX_FILE;
    }
    current.options = options;
  }
}
