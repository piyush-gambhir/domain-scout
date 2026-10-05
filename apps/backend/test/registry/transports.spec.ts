import { createServer as createHttpServer, type Server as HttpServer } from 'node:http';
import { createServer as createTcpServer, type AddressInfo, type Server as TcpServer, type Socket } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { FetchHttpTransport } from '../../src/registry/rdap/http-transport.js';
import { NetWhoisTransport, WhoisTransportError } from '../../src/registry/whois/whois-transport.js';

// Loopback servers only: these tests never reach the network.
const servers: (HttpServer | TcpServer)[] = [];
const sockets = new Set<Socket>();
afterEach(async () => {
  for (const socket of sockets) socket.destroy();
  sockets.clear();
  await Promise.all(servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve))));
});

async function listen<T extends HttpServer | TcpServer>(server: T): Promise<number> {
  servers.push(server);
  server.on('connection', (socket: Socket) => {
    sockets.add(socket);
    socket.on('error', () => undefined);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return (server.address() as AddressInfo).port;
}

describe('FetchHttpTransport', () => {
  it('does not follow redirects and caps the body size', async () => {
    const port = await listen(
      createHttpServer((req, res) => {
        if (req.url === '/redirect') {
          res.writeHead(302, { location: 'https://elsewhere.test/' }).end();
          return;
        }
        res.writeHead(200, { 'content-type': 'application/rdap+json' }).end('x'.repeat(5000));
      }),
    );
    const transport = new FetchHttpTransport();
    const signal = AbortSignal.timeout(5000);
    const redirect = await transport.get({ url: `http://127.0.0.1:${port}/redirect`, headers: {}, signal, maxBytes: 1000 });
    expect([redirect.status, redirect.headers.location]).toEqual([302, 'https://elsewhere.test/']);
    const big = await transport.get({ url: `http://127.0.0.1:${port}/big`, headers: {}, signal, maxBytes: 1000 });
    expect([big.status, big.body.length, big.truncated, big.headers['content-type']]).toEqual([200, 1000, true, 'application/rdap+json']);
  });
});

describe('NetWhoisTransport', () => {
  it('sends the query line with CRLF and reads until close', async () => {
    let received = '';
    const port = await listen(
      createTcpServer((socket) => {
        socket.once('data', (chunk) => {
          received = chunk.toString();
          socket.end('Domain: acme.de\nStatus: free\n');
        });
      }),
    );
    const result = await new NetWhoisTransport().query({ host: '127.0.0.1', port, query: '-T dn,ace acme.de', signal: AbortSignal.timeout(5000), maxBytes: 1000 });
    expect(received).toBe('-T dn,ace acme.de\r\n');
    expect(result).toEqual({ text: 'Domain: acme.de\nStatus: free\n', truncated: false });
  });

  it('marks oversized replies truncated', async () => {
    const port = await listen(createTcpServer((socket) => socket.once('data', () => socket.end('y'.repeat(4000)))));
    const result = await new NetWhoisTransport().query({ host: '127.0.0.1', port, query: 'x', signal: AbortSignal.timeout(5000), maxBytes: 100 });
    expect([result.text.length, result.truncated]).toEqual([100, true]);
  });

  it('rejects on abort and on refused connections', async () => {
    const port = await listen(createTcpServer(() => undefined));
    const controller = new AbortController();
    const pending = new NetWhoisTransport().query({ host: '127.0.0.1', port, query: 'x', signal: controller.signal, maxBytes: 100 });
    setTimeout(() => controller.abort(), 50);
    await expect(pending).rejects.toMatchObject({ code: 'aborted' });

    const closed = await listen(createTcpServer());
    await new Promise((resolve) => servers.pop()!.close(resolve));
    await expect(
      new NetWhoisTransport().query({ host: '127.0.0.1', port: closed, query: 'x', signal: AbortSignal.timeout(5000), maxBytes: 100 }),
    ).rejects.toBeInstanceOf(WhoisTransportError);
  });
});
