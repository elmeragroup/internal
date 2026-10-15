import { Schema } from "effect";

/** Plain HTTP, or TLS with a PEM key and certificate, where the server prefers HTTP/2. */
export const ServerTransport = Schema.Union([
  Schema.TaggedStruct("Http", {}),
  Schema.TaggedStruct("Https", { key: Schema.String, cert: Schema.String }),
]);
/** Decoded shape of {@link ServerTransport}. */
export type ServerTransport = typeof ServerTransport.Type;

/** What the idle-closing server thread is started with; parsed on the worker side. */
export const ServerOptions = Schema.Struct({
  transport: ServerTransport,
  /** Milliseconds a connection may sit idle before the server closes it. */
  idleLimit: Schema.Number,
  /** Backs one `Int32Array` counter of the connections the server has accepted. */
  connections: Schema.instanceOf(SharedArrayBuffer),
});
/** Decoded shape of {@link ServerOptions}. */
export type ServerOptions = typeof ServerOptions.Type;

/** The one message the server thread posts, once it listens. */
export const ServerListening = Schema.Struct({
  _tag: Schema.Literal("ServerListening"),
  port: Schema.Number,
});
/** Decoded shape of {@link ServerListening}. */
export type ServerListening = typeof ServerListening.Type;
