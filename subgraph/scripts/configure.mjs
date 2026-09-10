import fs from "node:fs";
import path from "node:path";

/**
 * Points `subgraph.yaml` and `networks.json` at a real deployment.
 *
 * The checked-in manifest carries zero addresses on purpose: a subgraph that ships with somebody's
 * old testnet addresses baked in is worse than one that obviously needs configuring. Run this after
 * `Deploy.s.sol` has written a manifest for the chain you are indexing.
 *
 *   node scripts/configure.mjs 84532
 */
const chainId = process.argv[2] ?? "84532";
if (chainId !== "84532") {
  throw new Error("The public Tremor subgraph targets Base Sepolia (84532).");
}

const deploymentPath = path.resolve("..", "contracts", "deployments", `${chainId}.json`);
if (!fs.existsSync(deploymentPath)) {
  throw new Error(`Missing deployment manifest: ${deploymentPath}. Run contracts/script/Deploy.s.sol first.`);
}
const deployment = JSON.parse(fs.readFileSync(deploymentPath, "utf8"));

if (deployment.schemaVersion !== 3) {
  throw new Error(
    `Deployment manifest is schemaVersion ${deployment.schemaVersion ?? "(absent)"}, not 3. ` +
      "The covered-market design renamed every contract key; re-run Deploy.s.sol.",
  );
}

const sources = {
  Controller: deployment.seriesFactory,
  Accumulator: deployment.accumulator,
  Router: deployment.router,
};
for (const [name, address] of Object.entries(sources)) {
  if (!address || /^0x0+$/i.test(address)) {
    throw new Error(`Deployment manifest has no usable address for ${name}`);
  }
}
const startBlock = deployment.deploymentBlock;
if (typeof startBlock !== "number") {
  throw new Error("Deployment manifest is missing deploymentBlock");
}

// Rewrite each data source's own address/startBlock pair, matched by data-source name so the three
// sources cannot be crossed over. Repeatable: it replaces whatever is there, placeholder or not.
let manifest = fs.readFileSync(path.resolve("subgraph.yaml"), "utf8");
for (const [name, address] of Object.entries(sources)) {
  const block = new RegExp(`(name:\\s*${name}\\b[\\s\\S]*?address:\\s*")[^"]*(")`);
  if (!block.test(manifest)) throw new Error(`subgraph.yaml has no data source named ${name}`);
  manifest = manifest.replace(block, `$1${address}$2`);
  const start = new RegExp(`(name:\\s*${name}\\b[\\s\\S]*?startBlock:\\s*)\\d+`);
  manifest = manifest.replace(start, `$1${startBlock}`);
}
fs.writeFileSync(path.resolve("subgraph.yaml"), manifest);

const networks = {
  "base-sepolia": Object.fromEntries(
    Object.entries(sources).map(([name, address]) => [name, { address, startBlock }]),
  ),
};
fs.writeFileSync(path.resolve("networks.json"), `${JSON.stringify(networks, null, 2)}\n`);

console.log(`Configured the Base Sepolia subgraph:`);
for (const [name, address] of Object.entries(sources)) {
  console.log(`  ${name.padEnd(12)} ${address}`);
}
console.log(`  startBlock   ${startBlock}`);
