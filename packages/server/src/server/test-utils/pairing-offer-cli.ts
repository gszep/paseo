// Playwright's worker must not import the server module graph: it pulls
// `@getpaseo/relay/e2ee` into the test process and poisons the later dynamic
// import of the built client. E2E callers run this entrypoint in a child
// process through `spawnTsx` instead. Reads one JSON argv, prints one JSON line.
import { generateLocalPairingOffer } from "../pairing-offer";

const args = JSON.parse(process.argv[2] ?? "{}") as Parameters<typeof generateLocalPairingOffer>[0];
const offer = await generateLocalPairingOffer(args);
process.stdout.write(JSON.stringify(offer));
