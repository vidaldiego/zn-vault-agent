import {beforeEach, describe, expect, it, vi} from 'vitest';

const pgQuery = vi.hoisted(() => vi.fn());
const pgRelease = vi.hoisted(() => vi.fn());
const pgEnd = vi.hoisted(() => vi.fn());
const pgPoolOn = vi.hoisted(() => vi.fn());
const pgConnect = vi.hoisted(() => vi.fn());
const PgPool = vi.hoisted(() => vi.fn(function MockPgPool() {
  return {
  connect: pgConnect,
  end: pgEnd,
  on: pgPoolOn,
  };
}));
vi.mock('pg', () => ({Pool: PgPool, default: {Pool: PgPool}}));

const mysqlQuery = vi.hoisted(() => vi.fn());
const mysqlRelease = vi.hoisted(() => vi.fn());
const mysqlEnd = vi.hoisted(() => vi.fn());
const mysqlGetConnection = vi.hoisted(() => vi.fn());
const createPool = vi.hoisted(() => vi.fn(() => ({
  getConnection: mysqlGetConnection,
  end: mysqlEnd,
})));
vi.mock('mysql2/promise', () => ({createPool}));

const loggerSpies = vi.hoisted(() => ({
  debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(),
}));
vi.mock('../../../lib/logger.js', () => ({createLogger: () => loggerSpies}));

const {PostgresClient} = await import('./postgres-client.js');
const {MysqlClient} = await import('./mysql-client.js');

beforeEach(() => {
  vi.clearAllMocks();
  pgConnect.mockResolvedValue({query: pgQuery, release: pgRelease});
  mysqlGetConnection.mockResolvedValue({query: mysqlQuery, release: mysqlRelease});
});

describe('dynamic credential existence probes', () => {
  it('binds the exact PostgreSQL role name through pg_catalog', async () => {
    pgQuery.mockResolvedValueOnce({rows: [{credential_exists: true}]});
    const client = new PostgresClient({
      connectionString: 'postgresql://admin:secret@db.example.test/app',
    });

    await expect(client.credentialExists('v_writer_exact')).resolves.toBe(true);

    expect(pgQuery).toHaveBeenCalledWith(
      expect.stringContaining('pg_catalog.pg_roles'),
      ['v_writer_exact']
    );
    expect(pgRelease).toHaveBeenCalled();
  });

  it('checks every MySQL Host row for the exact bound username', async () => {
    mysqlQuery.mockResolvedValueOnce([[{credential_exists: 0}], undefined]);
    const client = new MysqlClient({
      connectionString: 'mysql://admin:secret@db.example.test/app',
    });

    await expect(client.credentialExists('v_writer_exact')).resolves.toBe(false);

    expect(mysqlQuery).toHaveBeenCalledWith(
      expect.stringContaining('FROM mysql.user WHERE User = ?'),
      ['v_writer_exact']
    );
    expect(mysqlRelease).toHaveBeenCalled();
  });

  it('ensures an exact safe MySQL percent-host account is absent without mysql.user SELECT', async () => {
    mysqlQuery.mockResolvedValueOnce([[], undefined]);
    const client = new MysqlClient({
      connectionString: 'mysql://admin:secret@db.example.test/app',
    });

    await expect(client.ensureCredentialAbsent('v_writer_exact')).resolves.toBeUndefined();

    expect(mysqlQuery).toHaveBeenCalledWith(
      "DROP USER IF EXISTS 'v_writer_exact'@'%'"
    );
    expect(mysqlRelease).toHaveBeenCalled();
  });

  it('rejects an unsafe MySQL identity before issuing DROP USER', async () => {
    const client = new MysqlClient({
      connectionString: 'mysql://admin:secret@db.example.test/app',
    });

    await expect(client.ensureCredentialAbsent("bad'@'host"))
      .rejects.toThrow('Unsafe credential identity');
    expect(mysqlQuery).not.toHaveBeenCalled();
  });

  it.each([
    ['PostgreSQL', () => new PostgresClient({
      connectionString: 'postgresql://admin:secret@db.example.test/app',
    }), pgQuery],
    ['MySQL', () => new MysqlClient({
      connectionString: 'mysql://admin:secret@db.example.test/app',
    }), mysqlQuery],
  ] as const)('%s creation logs only statement metadata, never rendered SQL or password', async (
    _engine,
    makeClient,
    query
  ) => {
    const passwordCanary = 'password-canary-DO-NOT-LOG';
    const statementCanary = "CREATE USER '{{username}}' IDENTIFIED BY '{{password}}'";
    query.mockRejectedValueOnce(new Error(`driver exposed ${passwordCanary} ${statementCanary}`));
    const client = makeClient();

    await client.createCredential(
      [statementCanary],
      'v_exact_user',
      passwordCanary,
      'infinity'
    ).catch(() => undefined);

    const serializedLogs = JSON.stringify(
      Object.values(loggerSpies).map(spy => spy.mock.calls)
    );
    expect(serializedLogs).not.toContain(passwordCanary);
    expect(serializedLogs).not.toContain(statementCanary);
    expect(serializedLogs).not.toContain('driver exposed');
    expect(loggerSpies.debug).toHaveBeenCalledWith(expect.objectContaining({
      username: 'v_exact_user',
      statementNumber: 1,
      statementLength: expect.any(Number),
    }), 'Executing creation statement');
  });

  it.each([
    ['PostgreSQL', () => new PostgresClient({
      connectionString: 'postgresql://admin:secret@db.example.test/app',
    }), pgConnect],
    ['MySQL', () => new MysqlClient({
      connectionString: 'mysql://admin:secret@db.example.test/app',
    }), mysqlGetConnection],
  ] as const)('%s connection-test logs allowlisted metadata, never raw driver context', async (
    _engine,
    makeClient,
    getConnection
  ) => {
    const canary = 'connection-secret-canary';
    getConnection.mockRejectedValueOnce(Object.assign(
      new Error(`connection failed ${canary}`),
      {code: '08006', name: 'DatabaseError'}
    ));
    const client = makeClient();

    await expect(client.testConnection()).resolves.toBe(false);

    const serializedLogs = JSON.stringify(
      Object.values(loggerSpies).map(spy => spy.mock.calls)
    );
    expect(serializedLogs).not.toContain(canary);
    expect(serializedLogs).not.toContain('connection failed');
    expect(loggerSpies.error).toHaveBeenCalledWith(expect.objectContaining({
      databaseErrorCode: '08006',
      errorType: 'DatabaseError',
    }), expect.stringContaining('connection test failed'));
  });
});
