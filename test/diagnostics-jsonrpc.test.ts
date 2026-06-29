import { expect, test } from "bun:test";

import { createFrameDecoder, encodeMessage, isJsonRpcResponse } from "@/diagnostics/jsonrpc";
import type { JsonRpcMessage } from "@/diagnostics/jsonrpc";

function split(bytes: Uint8Array, at: number) {
  return [bytes.subarray(0, at), bytes.subarray(at)] as const;
}

test("isJsonRpcResponse accepts a null result and a well-formed error, rejects a malformed error", () => {
  expect(isJsonRpcResponse({ id: 1, result: null })).toBe(true);
  expect(isJsonRpcResponse({ error: { code: -1, message: "boom" }, id: 1 })).toBe(true);
  // The router would dereference error.message; a null/structureless error must not pass.
  expect(isJsonRpcResponse({ error: null, id: 1 })).toBe(false);
  expect(isJsonRpcResponse({ error: { code: -1 }, id: 1 })).toBe(false);
});

test("encodeMessage prefixes a byte-counted Content-Length header", () => {
  const framed = encodeMessage({ id: 1, jsonrpc: "2.0", method: "initialize", params: {} });
  const text = new TextDecoder().decode(framed);
  const body = JSON.stringify({ id: 1, jsonrpc: "2.0", method: "initialize", params: {} });
  expect(text).toBe(`Content-Length: ${body.length}\r\n\r\n${body}`);
});

test("decoder round-trips a single message fed whole", () => {
  const decode = createFrameDecoder();
  const message: JsonRpcMessage = { id: 7, jsonrpc: "2.0", result: { ok: true } };
  expect(decode(encodeMessage(message))).toEqual([message]);
});

test("decoder reassembles a message split mid-header", () => {
  const decode = createFrameDecoder();
  const framed = encodeMessage({ jsonrpc: "2.0", method: "$/progress", params: { token: "x" } });
  const [a, b] = split(framed, 8);
  expect(decode(a)).toEqual([]);
  expect(decode(b)).toEqual([{ jsonrpc: "2.0", method: "$/progress", params: { token: "x" } }]);
});

test("decoder reassembles a message split mid-body", () => {
  const decode = createFrameDecoder();
  const framed = encodeMessage({ id: 2, jsonrpc: "2.0", result: { value: "hello" } });
  const [a, b] = split(framed, framed.length - 4);
  expect(decode(a)).toEqual([]);
  expect(decode(b)).toEqual([{ id: 2, jsonrpc: "2.0", result: { value: "hello" } }]);
});

test("decoder emits every message when several arrive in one chunk", () => {
  const decode = createFrameDecoder();
  const first = encodeMessage({ id: 1, jsonrpc: "2.0", result: 1 });
  const second = encodeMessage({ id: 2, jsonrpc: "2.0", result: 2 });
  const combined = new Uint8Array(first.length + second.length);
  combined.set(first, 0);
  combined.set(second, first.length);
  expect(decode(combined)).toEqual([
    { id: 1, jsonrpc: "2.0", result: 1 },
    { id: 2, jsonrpc: "2.0", result: 2 },
  ]);
});

test("decoder keeps a multibyte body intact when the split falls inside a UTF-8 sequence", () => {
  const decode = createFrameDecoder();
  const message: JsonRpcMessage = { id: 3, jsonrpc: "2.0", result: { msg: "café — 🚀" } };
  const framed = encodeMessage(message);
  // Split one byte before the end so a multibyte sequence straddles the two chunks.
  const [a, b] = split(framed, framed.length - 1);
  expect(decode(a)).toEqual([]);
  expect(decode(b)).toEqual([message]);
});
