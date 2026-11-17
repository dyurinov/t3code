import {
  AuthWebSocketTicketResult,
  ORCHESTRATION_PROTOCOL_QUERY_PARAM,
  ORCHESTRATION_PROTOCOL_VERSION,
  WsRpcGroup,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as RpcClient from "effect/rpc/RpcClient";
import * as RpcSerialization from "effect/rpc/RpcSerialization";
import * as Socket from "effect/socket/Socket";

const decodeTicket = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Struct({ ticket: AuthWebSocketTicketResult.fields.ticket })),
);
const makeClient = RpcClient.make(WsRpcGroup);

/** An RPC client for the T3 server at `baseUrl`, as the holder of a bearer `token` minted there. */
export const environmentRpc = Effect.fn("devboxRpc.environmentRpc")(function* (
  baseUrl: string,
  token: string,
) {
  const http = yield* HttpClient.HttpClient;
  const response = yield* http.execute(
    HttpClientRequest.post(`${baseUrl}/api/auth/websocket-ticket/rpc`).pipe(
      HttpClientRequest.bearerToken(token),
    ),
  );
  if (response.status >= 400)
    return yield* Effect.fail(`The box refused an RPC ticket (HTTP ${response.status}).`);
  const { ticket } = yield* response.text.pipe(Effect.flatMap(decodeTicket));
  const url = new URL("/ws", baseUrl.replace(/^http/u, "ws"));
  url.searchParams.set("wsTicket", Redacted.value(ticket));
  url.searchParams.set(ORCHESTRATION_PROTOCOL_QUERY_PARAM, String(ORCHESTRATION_PROTOCOL_VERSION));
  const protocol = yield* Layer.build(
    Layer.effect(
      RpcClient.Protocol,
      RpcClient.makeProtocolSocket({
        retryTransientErrors: false,
        retryPolicy: Schedule.recurs(0),
      }),
    ).pipe(
      Layer.provide(
        Layer.mergeAll(
          Socket.layerWebSocket(url.toString()).pipe(
            Layer.provide(Socket.layerWebSocketConstructorGlobal),
          ),
          RpcSerialization.layerJson,
        ),
      ),
    ),
  );
  return yield* makeClient.pipe(Effect.provide(protocol));
});
