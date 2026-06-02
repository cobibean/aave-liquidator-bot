const fs = require("fs");
const path = require("path");
const solc = require("solc");

const contracts = [
  {
    sourcePath: path.join(__dirname, "..", "contracts", "AaveLiquidatorSwapRouter02.sol"),
    contractName: "AaveLiquidatorSwapRouter02",
  },
];

function main() {
  const sources = {};
  for (const contract of contracts) {
    sources[path.basename(contract.sourcePath)] = {
      content: fs.readFileSync(contract.sourcePath, "utf8"),
    };
  }

  const input = {
    language: "Solidity",
    sources,
    settings: {
      optimizer: {
        enabled: true,
        runs: 200,
      },
      viaIR: true,
      outputSelection: {
        "*": {
          "*": ["abi", "evm.bytecode.object", "evm.deployedBytecode.object"],
        },
      },
    },
  };

  const output = JSON.parse(solc.compile(JSON.stringify(input)));
  const errors = output.errors || [];
  for (const error of errors) {
    const log = error.severity === "error" ? console.error : console.warn;
    log(error.formattedMessage.trim());
  }

  if (errors.some((error) => error.severity === "error")) {
    process.exitCode = 1;
    return;
  }

  for (const contract of contracts) {
    const sourceName = path.basename(contract.sourcePath);
    const compiled = output.contracts[sourceName][contract.contractName];
    const artifact = {
      _format: "hh-sol-artifact-1",
      contractName: contract.contractName,
      sourceName: `contracts/${sourceName}`,
      abi: compiled.abi,
      bytecode: `0x${compiled.evm.bytecode.object}`,
      deployedBytecode: `0x${compiled.evm.deployedBytecode.object}`,
      linkReferences: {},
      deployedLinkReferences: {},
    };
    const artifactDir = path.join(
      __dirname,
      "..",
      "artifacts",
      "contracts",
      sourceName,
    );
    fs.mkdirSync(artifactDir, { recursive: true });
    fs.writeFileSync(
      path.join(artifactDir, `${contract.contractName}.json`),
      `${JSON.stringify(artifact, null, 2)}\n`
    );
    console.log(`Wrote ${contract.contractName} artifact`);
  }
}

main();
