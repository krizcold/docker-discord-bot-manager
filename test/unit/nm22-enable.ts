// Enable's role step and address step as enableFleetReplication sends them (its existence reads, then one stdin call
// each), for the real-Postgres rows that start from a main where Enable ran.
import { scramSha256Verifier } from '../../src/config/secretText';
import { type CallResult, clusterPsql, metaPsql, runCall } from '../../src/instance/dbLogin';
import { addressTableSql, enableRoleStepSql } from '../../src/instance/fleetReplication';
import { JOIN_LOGIN, copyLogin } from '../../src/instance/switchSql';

async function roleExists(container: string, name: string): Promise<boolean> {
  const read = await runCall(container, clusterPsql(container, `SELECT count(*) FROM pg_roles WHERE rolname = '${name}';`));
  if (!read.ok) throw new Error(`reading whether ${name} exists failed: ${read.stderr}`);
  return read.stdout.trim() !== '0';
}

/** The role step: the join login, COPY_ROLES_SQL, this machine's own login and the reopening loop in one transaction. */
export async function enableRoleStep(container: string, o: { joinPassword: string; ownId: string; ownPassword: string }): Promise<CallResult> {
  const ownLogin = copyLogin(o.ownId);
  const joinExists = await roleExists(container, JOIN_LOGIN);
  const ownExists = await roleExists(container, ownLogin);
  const step = enableRoleStepSql({ joinExists, joinVerifier: scramSha256Verifier(o.joinPassword), ownLogin, ownExists, ownVerifier: scramSha256Verifier(o.ownPassword) });
  return runCall(container, clusterPsql(container, step, { stdin: true }));
}

/** The address step as dbm_meta in the bot's database: the table, the two functions and the main's own row. */
export function enableAddressStep(container: string, db: string, host: string, port: number, certPem: string, machine: string): Promise<CallResult> {
  return runCall(container, metaPsql(container, db, `BEGIN;\n${addressTableSql(host, port, certPem, machine)}COMMIT;\n`, { stdin: true }));
}
