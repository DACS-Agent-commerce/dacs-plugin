// Read-only starter for first-time viewers (DACS_SHOWCASE_WALKTHROUGH=on):
// two explicit choices, a labelled walkthrough or a live testnet purchase.
// It reads only config and prepares, signs and sends nothing.
// The top-level livePurchaseComposed says only that the app was built with the
// live testnet purchase capabilities and a protocol that can prepare that
// purchase. It does not say the seller is running or that the caller's account
// is admitted: the tool is public and cannot know either.
import * as z from 'zod/v4';

const choice = z.object({
  id: z.enum(['walkthrough', 'live-testnet-purchase']),
  title: z.string(),
  realTransactions: z.boolean(),
  url: z.string().nullable(),
  startWith: z.array(z.string()),
  needs: z.array(z.string()),
  note: z.string(),
}).strict();

export function showcaseChoices({ publicOrigin, livePurchase }) {
  return [
    {
      id: 'walkthrough', title: 'Walk through a purchase (read-only)', realTransactions: false,
      url: `${publicOrigin}/portal/showcase/`, startWith: [], needs: [],
      note: 'Illustrative pages: they cannot sign, pay or buy, and their examples are not real transactions.',
    },
    {
      id: 'live-testnet-purchase', title: 'Make a live testnet purchase', realTransactions: livePurchase,
      url: null, startWith: livePurchase ? ['search_agents', 'get_listing', 'prepare_purchase'] : [],
      needs: livePurchase ? ['sign in to the DACS app', 'a wallet set up in the DACS portal', 'testnet DEM for the price and transaction fees'] : [],
      note: livePurchase
        ? 'This server has the live testnet purchase setup: real Demos testnet transactions, testnet DEM only, and the user approves each buyer-side signature and transaction in their wallet. The operator controls whether its seller is running and which accounts may buy, and may admit only its own test accounts; a purchase can also wait for the seller\'s approval. Payment is held: a purchase stops at the Agreement and the seller\'s commitment, with no payment or report, until independent commitment finality is established. This tool cannot tell whether this user can buy.'
        : 'Live testnet purchases are not set up on this server.',
    },
  ];
}

export function registerShowcaseStart(server, { config, livePurchase, guard, noauth }) {
  server.registerTool('start_showcase', {
    title: 'Start the DACS showcase',
    description: 'Use this when a first-time user wants to see what DACS does, or has no testnet DEM yet. Returns two explicit choices for the user to pick from: a read-only walkthrough page (illustrative, no purchase capability) or a live Demos testnet purchase. Present both; never present walkthrough examples as a real purchase or status. The top-level livePurchaseComposed says whether this server was built for live purchases, not whether its seller is running or this user can buy. Prepares, signs and sends nothing.',
    inputSchema: z.object({}).strict(),
    outputSchema: z.object({ livePurchaseComposed: z.boolean(), choices: z.array(choice).length(2) }).strict(),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    _meta: { securitySchemes: noauth },
  }, guard('start_showcase', async () => {
    const choices = showcaseChoices({ publicOrigin: config.publicOrigin, livePurchase });
    const summary = `Two choices. 1) ${choices[0].title}: ${choices[0].url} (${choices[0].note}) 2) ${choices[1].title}: ${choices[1].note}`;
    return { structuredContent: { livePurchaseComposed: livePurchase, choices }, content: [{ type: 'text', text: summary }] };
  }));
}
