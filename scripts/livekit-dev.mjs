#!/usr/bin/env node
/**
 * Starts the LiveKit dev server (keys devkey / secret) advertising this machine's LAN IPv4.
 *
 * LiveKit hands its --node-ip to clients as the ICE candidate for media. 127.0.0.1 breaks as soon as the
 * browser gathers candidates on another interface (network change, VPN), and the Android emulator can't
 * use it at all, so the LAN address is detected at start time. Override with NODE_IP=…
 * Listens on 0.0.0.0, i.e. it is reachable from the LAN: stop it when you're done.
 */
import { spawn } from 'node:child_process';
import { networkInterfaces } from 'node:os';

function lanIPv4() {
  const candidates = Object.entries(networkInterfaces()).flatMap(([name, addrs]) =>
    (addrs ?? [])
      .filter((a) => a.family === 'IPv4' && !a.internal && !a.address.startsWith('169.254.'))
      .map((a) => ({ name, address: a.address })),
  );
  // Prefer physical interfaces (macOS en*, Linux eth*/wl*) over VPN tunnels and bridges.
  const physical = candidates.find((c) => /^(en|eth|wl)/.test(c.name));
  return (physical ?? candidates[0])?.address;
}

const nodeIp = process.env.NODE_IP || lanIPv4();
if (!nodeIp) {
  console.error('[livekit:dev] No LAN IPv4 address found; set NODE_IP=<address> and retry.');
  process.exit(1);
}

console.log(`[livekit:dev] advertising ${nodeIp} (ws://127.0.0.1:7880 or ws://${nodeIp}:7880)`);
const child = spawn('livekit-server', ['--dev', '--bind', '0.0.0.0', '--node-ip', nodeIp, ...process.argv.slice(2)], {
  stdio: 'inherit',
});
child.on('error', (err) => {
  console.error(`[livekit:dev] could not start livekit-server: ${err.message}`);
  process.exit(1);
});
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
child.on('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
