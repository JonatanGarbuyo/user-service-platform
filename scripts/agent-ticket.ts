import { runAgentTicket } from './agent/ticket-flow.js';

// Supported entrypoint for ticket #23: `npm run agent:ticket -- <issue>`.
// Takes one approved `ready-for-agent` implementation ticket from a clean
// `main` worktree through implementation, draft PR creation, and the existing
// deterministic `review:cycle`, stopping at READY FOR FINAL ACCEPTANCE.
// Never merges, deploys, publishes, mutates Cloudflare resources, or handles
// secrets. Headless-safe: no interactive stdin/questions; human-required
// decisions and failures stop with a non-zero exit status and durable
// evidence (branch/PR/run summary) left in place for manual inspection.
async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const [ticketArg, ...rest] = argv;
  if (ticketArg === '--help' || ticketArg === '-h') {
    console.log('usage: agent-ticket <issue-number>');
    return;
  }
  if (ticketArg === undefined) {
    console.error('AGENT-TICKET BLOCKED (validate): missing issue number.');
    console.error('usage: agent-ticket <issue-number>');
    process.exitCode = 1;
    return;
  }
  if (rest.length > 0) {
    console.error(`AGENT-TICKET BLOCKED (validate): unknown argument: ${rest[0] ?? '(missing)'}`);
    console.error('usage: agent-ticket <issue-number>');
    process.exitCode = 1;
    return;
  }

  const result = await runAgentTicket(ticketArg);
  process.exitCode = result.exitCode;
}

await main().catch((error: unknown) => {
  console.error(`AGENT-TICKET FATAL: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
