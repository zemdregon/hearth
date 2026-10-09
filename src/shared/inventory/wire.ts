import type { StockDimension } from './stock';

/** JSON wire shapes for the household inventory API. Quantities are integer base units. */
export type InvLocationKind = 'pantry' | 'fridge' | 'freezer' | 'other';
export type InvLocation = { id: string; name: string; kind: InvLocationKind; version: number };
export type InvItem = { id: string; name: string; dim: StockDimension; version: number };
export type InvLot = {
  id: string; itemId: string; locationId: string | null; qty: number; precision: 'exact' | 'estimated'; estBp: number;
  enteredText: string; dateKind: 'best_by' | 'use_by' | null; date: string | null; note: string; version: number; createdAt: number; updatedAt: number;
};
export type InventoryState = { locations: InvLocation[]; items: InvItem[]; lots: InvLot[]; aliases: InvAlias[]; calibrations: InvCalibration[]; settings: InvSettings };
export type InvLedgerKind = 'add' | 'adjust' | 'count' | 'archive';
export type InvLedgerEntry = { seq: number; txnId: string; kind: InvLedgerKind; memberId: string; lotId: string; itemId: string; itemName: string; dim: StockDimension; delta: number; qtyAfter: number; reason: string; createdAt: number };
export type InvLotResult = { lots: InvLot[]; replayed: boolean };
export type InventoryExport = InventoryState & { ledger: InvLedgerEntry[]; ledgerTruncated: boolean };

/** Household measuring convention for recipe cups/spoons; null until an administrator chooses one. */
export type InvProfile = 'us-customary' | 'us-label' | 'metric-250';
export type InvSettings = { measureProfile: InvProfile | null; version: number };
/** A reviewed mapping from a recipe ingredient name (normalised) to one inventory item. */
export type InvAlias = { id: string; name: string; itemId: string; version: number };
/** An accepted household conversion for one item across dimensions, e.g. 1 cup = 120 g. */
export type InvCalibration = {
  id: string; itemId: string; fromAmount: string; fromUnit: string; fromProfile: InvProfile | null;
  toAmount: string; toUnit: string; toProfile: InvProfile | null; version: number;
};
export type InvVerdict = 'sufficient' | 'insufficient' | 'unknown';
/** Quantities are stored base units (ng / nL / counts), rounded outward (lo down, hi up). */
export type InvRange = { lo: number; hi: number };
export type AvailabilityItem = {
  itemId: string; itemName: string; dim: StockDimension; lineIndexes: number[]; verdict: InvVerdict; reasons: string[];
  need: InvRange; have: InvRange; needComplete: boolean; haveComplete: boolean; short: InvRange | null;
};
export type AvailabilityResult = {
  verdict: InvVerdict; servings: number; recipeServings: number;
  items: AvailabilityItem[];
  /** Recipe lines with no reviewed mapping: they prevent a sufficient verdict until mapped or excluded. */
  unmapped: { index: number; name: string }[];
  excluded: number[];
};

/** One lot's proposed share of a recipe's need, taken earliest date first. */
export type ConsumeAllocation = { lotId: string; version: number; enteredText: string; locationId: string | null; date: string | null; dateKind: 'best_by' | 'use_by' | null; precision: 'exact' | 'estimated'; available: number; take: number };
export type ConsumeLine = {
  itemId: string; itemName: string; dim: StockDimension; lineIndexes: number[]; reasons: string[];
  need: InvRange; needComplete: boolean;
  /** need.hi when the need is complete, otherwise null: the cook must enter what was actually used. */
  suggested: number | null;
  allocations: ConsumeAllocation[];
  /** Part of `suggested` that recorded stock cannot cover. */
  shortfall: number;
};
export type ConsumePreview = {
  recipeId: string; recipeTitle: string; servings: number; lines: ConsumeLine[];
  unmapped: { index: number; name: string }[]; excluded: number[];
};
export type ConsumeResult = InvLotResult & { txnId: string };
export type InvConsumption = {
  txnId: string; recipeId: string | null; recipeTitle: string; servings: number; memberId: string; createdAt: number;
  lots: { lotId: string; itemId: string; itemName: string; dim: StockDimension; delta: number }[]; shortfalls: { itemId: string; itemName: string; dim: StockDimension; amount: number }[];
  /** Transaction that reversed this one, if any. */
  undoneBy: string | null;
  /** True only when no later activity touched any lot it changed, so undoing is exact. */
  canUndo: boolean;
  /** Set on an undo entry: the consumption it reversed. */
  reverses: string | null;
};
