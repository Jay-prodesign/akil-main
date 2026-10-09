/**
 * Provider-neutral SQL execution boundary. Any real driver (`pg`,
 * `postgres`, a Neon/PlanetScale HTTP client, a test fake) can satisfy
 * this by wrapping its own client - callers never import a specific
 * driver package directly, mirroring `connector-execution.ts`'s injected
 * `ConnectorTransport` boundary. `query` always takes parameterized SQL;
 * no caller in this codebase may build a query string by interpolating a
 * value directly (that would be a SQL-injection vector this interface
 * exists specifically to foreclose).
 */
export interface SqlClient {
  query<Row>(text: string, params: ReadonlyArray<unknown>): Promise<{ rows: ReadonlyArray<Row> }>;
}
