import test from 'node:test';
import assert from 'node:assert/strict';
import {Readable} from 'node:stream';
import {EventEmitter} from 'node:events';
import {redisRequestOriginAllowed} from './requestOrigin.js';
import {redisLayersPlugin} from './plugin.js';

const publicOrigin = 'https://rl-s-labs-uwzdaa.labs.ps-redis.com';
const request = (origin, headers = {}, socket = {}) => ({
  headers: {host: '127.0.0.1:8080', origin, ...headers}, socket,
});

test('explicit public origin accepts portal Host rewriting but refuses foreign origins', () => {
  const env = {GEV_PUBLIC_ORIGIN: publicOrigin};
  assert.equal(redisRequestOriginAllowed(request(publicOrigin), env), true);
  for (const origin of ['https://attacker.example', publicOrigin + '.attacker.example',
    publicOrigin.replace('https:', 'http:'), publicOrigin + ':8443', 'null', '',
    publicOrigin + '/path', publicOrigin + '?query=1', publicOrigin + '#fragment',
    'https://user@rl-s-labs-uwzdaa.labs.ps-redis.com', ['https://attacker.example']]) {
    assert.equal(redisRequestOriginAllowed(request(origin), env), false, String(origin));
  }
  assert.equal(redisRequestOriginAllowed(request('http://127.0.0.1:8080'), env), false);
});

test('invalid configured origins fail closed', () => {
  for (const value of ['*', 'null', publicOrigin + '/path', publicOrigin + ',https://other.example']) {
    assert.equal(redisRequestOriginAllowed(request(publicOrigin), {GEV_PUBLIC_ORIGIN: value}), false);
  }
});

test('direct origins normalize default ports and still compare scheme and nondefault ports', () => {
  assert.equal(redisRequestOriginAllowed(request('http://localhost', {host:'localhost:80'}), {}), true);
  assert.equal(redisRequestOriginAllowed(request('http://localhost:8080', {host:'localhost:8080'}), {}), true);
  assert.equal(redisRequestOriginAllowed(request('https://localhost:8080', {host:'localhost:8080'}), {}), false);
  assert.equal(redisRequestOriginAllowed(request('http://localhost:8081', {host:'localhost:8080'}), {}), false);
  assert.equal(redisRequestOriginAllowed(request(undefined), {}), true);
});

test('forwarded protocol is used only for the opted-in loopback container proxy', () => {
  const headers = {host:'lab.example', 'x-forwarded-proto':'https', 'x-gev-setup-proxy':'1'};
  const env = {GEV_TRUST_SETUP_PROXY:'true'};
  assert.equal(redisRequestOriginAllowed(request('https://lab.example', headers, {remoteAddress:'127.0.0.1'}), env), true);
  assert.equal(redisRequestOriginAllowed(request('https://lab.example', headers, {remoteAddress:'192.0.2.1'}), env), false);
  assert.equal(redisRequestOriginAllowed(request('https://lab.example', headers, {remoteAddress:'127.0.0.1'}), {}), false);
  assert.equal(redisRequestOriginAllowed(request('https://lab.example', {...headers,'x-forwarded-proto':'https,http'}, {remoteAddress:'127.0.0.1'}), env), false);
});

test('ingest, local and retry all enforce the configured origin before touching Redis', async () => {
  const previous = process.env.GEV_PUBLIC_ORIGIN;
  process.env.GEV_PUBLIC_ORIGIN = publicOrigin;
  let middleware;
  const httpServer = new EventEmitter();
  httpServer.address = () => ({port:4173});
  const plugin = redisLayersPlugin();
  plugin.configureServer({httpServer, middlewares:{use:(_path, handler) => {middleware = handler;}}});
  try {
    for (const route of ['/ingest', '/local', '/retry']) {
      for (const [origin, expected] of [[publicOrigin,400], ['https://attacker.example',403], ['null',403]]) {
        const req = Readable.from([JSON.stringify({layer:'__invalid__',layers:['__invalid__']})]);
        Object.assign(req, request(origin, {'content-type':'application/json'}), {method:'POST',url:route});
        const res = new EventEmitter();
        res.writeHead = code => {res.status = code;};
        res.end = text => {res.body = JSON.parse(text);res.writableEnded = true;};
        await middleware(req,res);
        assert.equal(res.status,expected,`${route} ${origin}: ${JSON.stringify(res.body)}`);
      }
    }
  } finally {
    if (previous === undefined) delete process.env.GEV_PUBLIC_ORIGIN;
    else process.env.GEV_PUBLIC_ORIGIN = previous;
    await plugin.closeBundle();
  }
});
