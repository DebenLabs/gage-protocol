/**
 * Minimal ABIs, typed `as const` for viem. Signatures are copied from the compiled artifacts:
 * contracts/out/DealVault.sol, contracts/out/CollateralRegistry.sol and
 * contracts/lib/v4-periphery/foundry-out/{StateView,PositionManager,PoolManager}.sol.
 */
export const dealVaultAbi = [
  {
    type: "function",
    name: "getDeal",
    stateMutability: "view",
    inputs: [{ name: "dealId", type: "uint256" }],
    outputs: [
      {
        name: "",
        type: "tuple",
        components: [
          { name: "borrower", type: "address" },
          { name: "kind", type: "uint8" },
          { name: "state", type: "uint8" },
          { name: "term", type: "uint32" },
          { name: "listingExpiry", type: "uint40" },
          { name: "token", type: "address" },
          { name: "fundedAt", type: "uint40" },
          { name: "expiry", type: "uint40" },
          { name: "amountOrTokenId", type: "uint256" },
          { name: "cap", type: "uint128" },
          { name: "minPrice", type: "uint128" },
          { name: "lender", type: "address" },
          { name: "price", type: "uint128" },
          { name: "fee", type: "uint128" }
        ]
      }
    ]
  },
  { type: "function", name: "dealCount", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "uint256" }] },
  { type: "function", name: "POSITION_MANAGER", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "address" }] },
  { type: "function", name: "USDG", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "address" }] }
] as const;

/**
 * The Deal struct before the trailing `fee` field was added. The vault deployed on testnet 46630 on 2026-09-07
 * still returns this 13-word shape; the reader picks the ABI by the length of the return data.
 */
export const dealVaultLegacyAbi = [
  {
    type: "function",
    name: "getDeal",
    stateMutability: "view",
    inputs: [{ name: "dealId", type: "uint256" }],
    outputs: [
      {
        name: "",
        type: "tuple",
        components: [
          { name: "borrower", type: "address" },
          { name: "kind", type: "uint8" },
          { name: "state", type: "uint8" },
          { name: "term", type: "uint32" },
          { name: "listingExpiry", type: "uint40" },
          { name: "token", type: "address" },
          { name: "fundedAt", type: "uint40" },
          { name: "expiry", type: "uint40" },
          { name: "amountOrTokenId", type: "uint256" },
          { name: "cap", type: "uint128" },
          { name: "minPrice", type: "uint128" },
          { name: "lender", type: "address" },
          { name: "price", type: "uint128" }
        ]
      }
    ]
  }
] as const;

export const registryAbi = [
  {
    type: "function",
    name: "getERC20Config",
    stateMutability: "view",
    inputs: [{ name: "token", type: "address" }],
    outputs: [
      {
        name: "",
        type: "tuple",
        components: [
          { name: "allowed", type: "bool" },
          { name: "lane", type: "uint8" },
          { name: "minAmount", type: "uint256" },
          { name: "maxDealRaw", type: "uint256" },
          { name: "maxOpenRaw", type: "uint256" }
        ]
      }
    ]
  }
] as const;

export const erc20Abi = [
  { type: "function", name: "decimals", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "uint8" }] },
  { type: "function", name: "symbol", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "string" }] },
  { type: "function", name: "name", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "string" }] },
  { type: "function", name: "totalSupply", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "uint256" }] },
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ name: "a", type: "address" }], outputs: [{ name: "", type: "uint256" }] },
  { type: "function", name: "paused", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "bool" }] }
] as const;

/** Selectors a timelock or locker commonly exposes; each is tried in turn. */
export const unlockAbi = [
  { type: "function", name: "unlockTime", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "uint256" }] },
  { type: "function", name: "releaseTime", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "uint256" }] },
  { type: "function", name: "unlockAt", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "uint256" }] },
  { type: "function", name: "end", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "uint256" }] }
] as const;

export const stateViewAbi = [
  {
    type: "function",
    name: "getSlot0",
    stateMutability: "view",
    inputs: [{ name: "poolId", type: "bytes32" }],
    outputs: [
      { name: "sqrtPriceX96", type: "uint160" },
      { name: "tick", type: "int24" },
      { name: "protocolFee", type: "uint24" },
      { name: "lpFee", type: "uint24" }
    ]
  },
  { type: "function", name: "getLiquidity", stateMutability: "view", inputs: [{ name: "poolId", type: "bytes32" }], outputs: [{ name: "liquidity", type: "uint128" }] },
  {
    type: "function",
    name: "getTickInfo",
    stateMutability: "view",
    inputs: [
      { name: "poolId", type: "bytes32" },
      { name: "tick", type: "int24" }
    ],
    outputs: [
      { name: "liquidityGross", type: "uint128" },
      { name: "liquidityNet", type: "int128" },
      { name: "feeGrowthOutside0X128", type: "uint256" },
      { name: "feeGrowthOutside1X128", type: "uint256" }
    ]
  },
  {
    type: "function",
    name: "getFeeGrowthInside",
    stateMutability: "view",
    inputs: [
      { name: "poolId", type: "bytes32" },
      { name: "tickLower", type: "int24" },
      { name: "tickUpper", type: "int24" }
    ],
    outputs: [
      { name: "feeGrowthInside0X128", type: "uint256" },
      { name: "feeGrowthInside1X128", type: "uint256" }
    ]
  },
  {
    type: "function",
    name: "getPositionInfo",
    stateMutability: "view",
    inputs: [
      { name: "poolId", type: "bytes32" },
      { name: "owner", type: "address" },
      { name: "tickLower", type: "int24" },
      { name: "tickUpper", type: "int24" },
      { name: "salt", type: "bytes32" }
    ],
    outputs: [
      { name: "liquidity", type: "uint128" },
      { name: "feeGrowthInside0LastX128", type: "uint256" },
      { name: "feeGrowthInside1LastX128", type: "uint256" }
    ]
  }
] as const;

export const positionManagerAbi = [
  {
    type: "function",
    name: "getPoolAndPositionInfo",
    stateMutability: "view",
    inputs: [{ name: "tokenId", type: "uint256" }],
    outputs: [
      {
        name: "poolKey",
        type: "tuple",
        components: [
          { name: "currency0", type: "address" },
          { name: "currency1", type: "address" },
          { name: "fee", type: "uint24" },
          { name: "tickSpacing", type: "int24" },
          { name: "hooks", type: "address" }
        ]
      },
      { name: "info", type: "uint256" }
    ]
  },
  { type: "function", name: "getPositionLiquidity", stateMutability: "view", inputs: [{ name: "tokenId", type: "uint256" }], outputs: [{ name: "liquidity", type: "uint128" }] },
  { type: "function", name: "ownerOf", stateMutability: "view", inputs: [{ name: "id", type: "uint256" }], outputs: [{ name: "owner", type: "address" }] }
] as const;

export const poolManagerEventsAbi = [
  {
    type: "event",
    name: "Initialize",
    anonymous: false,
    inputs: [
      { name: "id", type: "bytes32", indexed: true },
      { name: "currency0", type: "address", indexed: true },
      { name: "currency1", type: "address", indexed: true },
      { name: "fee", type: "uint24", indexed: false },
      { name: "tickSpacing", type: "int24", indexed: false },
      { name: "hooks", type: "address", indexed: false },
      { name: "sqrtPriceX96", type: "uint160", indexed: false },
      { name: "tick", type: "int24", indexed: false }
    ]
  },
  {
    type: "event",
    name: "ModifyLiquidity",
    anonymous: false,
    inputs: [
      { name: "id", type: "bytes32", indexed: true },
      { name: "sender", type: "address", indexed: true },
      { name: "tickLower", type: "int24", indexed: false },
      { name: "tickUpper", type: "int24", indexed: false },
      { name: "liquidityDelta", type: "int256", indexed: false },
      { name: "salt", type: "bytes32", indexed: false }
    ]
  },
  {
    type: "event",
    name: "Swap",
    anonymous: false,
    inputs: [
      { name: "id", type: "bytes32", indexed: true },
      { name: "sender", type: "address", indexed: true },
      { name: "amount0", type: "int128", indexed: false },
      { name: "amount1", type: "int128", indexed: false },
      { name: "sqrtPriceX96", type: "uint160", indexed: false },
      { name: "liquidity", type: "uint128", indexed: false },
      { name: "tick", type: "int24", indexed: false },
      { name: "fee", type: "uint24", indexed: false }
    ]
  }
] as const;

/** Compiled from probe/TransferProbe.sol (solc 0.8.28, optimizer 200 runs, cancun). Injected via eth_call state override. */
export const transferProbeAbi = [
  {
    type: "function",
    name: "probe",
    stateMutability: "nonpayable",
    inputs: [
      { name: "token", type: "address" },
      { name: "to", type: "address" },
      { name: "amount", type: "uint256" }
    ],
    outputs: [
      { name: "ok", type: "bool" },
      { name: "sentDelta", type: "uint256" },
      { name: "receivedDelta", type: "uint256" }
    ]
  }
] as const;

export const transferProbeBytecode =
  "0x608060405234801561000f575f5ffd5b5060043610610029575f3560e01c8063dd8e5ec91461002d575b5f5ffd5b61004061003b36600461033a565b610061565b60408051931515845260208401929092529082015260600160405180910390f35b6040516370a0823160e01b81523060048201525f9081908190869082906001600160a01b038316906370a0823190602401602060405180830381865afa1580156100ad573d5f5f3e3d5ffd5b505050506040513d601f19601f820116820180604052508101906100d19190610373565b6040516370a0823160e01b81526001600160a01b0389811660048301529192505f918416906370a0823190602401602060405180830381865afa15801561011a573d5f5f3e3d5ffd5b505050506040513d601f19601f8201168201806040525081019061013e9190610373565b6040516001600160a01b038a81166024830152604482018a90529192505f9182919086169060640160408051601f198184030181529181526020820180516001600160e01b031663a9059cbb60e01b1790525161019b919061038a565b5f604051808303815f865af19150503d805f81146101d4576040519150601f19603f3d011682016040523d82523d5f602084013e6101d9565b606091505b509150915081801561020357508051158061020357508080602001905181019061020391906103a0565b6040516370a0823160e01b81523060048201529098505f906001600160a01b038716906370a0823190602401602060405180830381865afa15801561024a573d5f5f3e3d5ffd5b505050506040513d601f19601f8201168201806040525081019061026e9190610373565b6040516370a0823160e01b81526001600160a01b038d811660048301529192505f918816906370a0823190602401602060405180830381865afa1580156102b7573d5f5f3e3d5ffd5b505050506040513d601f19601f820116820180604052508101906102db9190610373565b90508186116102ea575f6102f4565b6102f482876103c6565b9850848111610303575f61030d565b61030d85826103c6565b97505050505050505093509350939050565b80356001600160a01b0381168114610335575f5ffd5b919050565b5f5f5f6060848603121561034c575f5ffd5b6103558461031f565b92506103636020850161031f565b9150604084013590509250925092565b5f60208284031215610383575f5ffd5b5051919050565b5f82518060208501845e5f920191825250919050565b5f602082840312156103b0575f5ffd5b815180151581146103bf575f5ffd5b9392505050565b818103818111156103e557634e487b7160e01b5f52601160045260245ffd5b9291505056fea2646970667358221220fbd9ec366e5a62921947863d4683e9af86343672e301c79f33a4c08b7845a3d764736f6c634300081c0033" as const;
