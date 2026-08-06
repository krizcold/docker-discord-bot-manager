/**
 * dbm - console control for the Discord Bot Manager.
 * A loopback-only HTTP client over the manager's own web-UI API. Every verb maps to
 * an existing route, so the console does exactly what the UI does and nothing more.
 */

import { parseArgs, flagStr } from './args';
import { resolveTarget, Client, LoopbackError } from './client';
import { dispatch } from './commands';
import { fail, EXIT_USAGE } from './output';

const HELP = `dbm - Discord Bot Manager console

Usage: dbm [--port N | --url URL] [--json] <command> [args]

Sources:  sources list | add <url> [--name N] [--branch B] | info <id> | rm <id> | fetch <id> | envs <id> [--scan]
Bots:     bots list | info <id> | create (--source <id>|--image <ref> --name N) | start|restart|build|update <id> [--wait]
          bots stop <id> | delete <id> [--keep-data] [--no-keep-env] | check-updates <id> | containers <id> | stats <id>
          bots logs <id> [--tail N] | build-logs <id> [--follow] | container-logs <id> <name> [--lines N] [--follow]
          bots web-auth <id> <auto|managed|public> | port <id|name>
Env:      env get <id> | set <id> KEY=VAL [KEY=VAL ...]
Config:   config get <id> | set <id> --body '{"files":[...]}'
Vault:    vault list | values | set <key> <value> | update <key> <value> | rm <key>
Manager:  manager version | manager update | deployment | health
Raw:      api <METHOD> <path> [--body JSON]
          events [--filter PREFIX] [--timeout S]
          wait --get <path> --until <expr> [--interval MS] [--timeout S]

Global flags:
  --port N        target 127.0.0.1:N (default: $PORT or 8080; standalone host uses 8090)
  --url URL       loopback URL override (rejected if not 127.0.0.1/::1/localhost)
  --json          force JSON output (also implied when stdout is not a TTY)
  --wait          block on the terminal WebSocket event for async lifecycle verbs
  --timeout S     seconds before --wait / wait / SSE gives up
`;

async function main(): Promise<void> {
  const { positionals, flags } = parseArgs(process.argv.slice(2));

  if (flags.help || positionals.length === 0) {
    process.stdout.write(HELP);
    process.exit(positionals.length === 0 ? EXIT_USAGE : 0);
  }

  let client: Client;
  try {
    client = new Client(resolveTarget({ url: flagStr(flags, 'url'), port: flagStr(flags, 'port') }));
  } catch (err) {
    if (err instanceof LoopbackError) fail(err.message, EXIT_USAGE);
    throw err;
  }

  await dispatch(client, positionals, flags);
}

main().catch((err) => {
  fail(err instanceof Error ? err.message : String(err));
});
