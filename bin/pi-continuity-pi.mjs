#!/usr/bin/env node
import { createContinuityPiSession } from '../src/pi-host.mjs';

const [goal, ...rest] = process.argv.slice(2);
if (!goal) { console.error('usage: pi-continuity-pi "goal" [--record|--off]'); process.exit(2); }
const mode = rest.includes('--off') ? 'off' : rest.includes('--record') ? 'record' : 'active';
const replacementAware = rest.includes('--runtime');
let host;
try {
  host = await createContinuityPiSession({ goal, mode, replacementAware });
  host.session.subscribe(event => {
    if (event.type === 'message_update' && event.assistantMessageEvent?.type === 'text_delta') process.stdout.write(event.assistantMessageEvent.delta);
  });
  await host.session.prompt(goal);
  process.stdout.write('\n');
} finally { await host?.close(); }
