export interface PgQueryResult {
  rows: readonly unknown[];
  rowCount?: number | null;
}

/** Minimal Postgres query seam for stores, schema helpers, and tests. */
export interface PgQueryable {
  query(sql: string, params?: readonly unknown[]): Promise<PgQueryResult>;
}

export interface PgClientLike extends PgQueryable {
  release(): void;
}

export interface PgListenClient extends PgClientLike {
  on(event: "notification", listener: (message: {channel: string; payload?: string}) => void): this;
  on(event: "error", listener: (error: unknown) => void): this;
  on(event: "end", listener: () => void): this;
  off(event: "notification", listener: (message: {channel: string; payload?: string}) => void): this;
  off(event: "error", listener: (error: unknown) => void): this;
  off(event: "end", listener: () => void): this;
}

export interface PgPoolLike<Client extends PgClientLike = PgClientLike> extends PgQueryable {
  connect(): Promise<Client>;
}
