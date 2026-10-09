import type { StockDimension } from './stock';

/** JSON wire shapes for the household inventory API. Quantities are integer base units. */
export type InvLocationKind = 'pantry' | 'fridge' | 'freezer' | 'other';
export type InvLocation = { id: string; name: string; kind: InvLocationKind; version: number };
export type InvItem = { id: string; name: string; dim: StockDimension; version: number };
export type InvLot = {
  id: string; itemId: string; locationId: string | null; qty: number; precision: 'exact' | 'estimated'; estBp: number;
  enteredText: string; dateKind: 'best_by' | 'use_by' | null; date: string | null; note: string; version: number; createdAt: number; updatedAt: number;
};
export type InventoryState = { locations: InvLocation[]; items: InvItem[]; lots: InvLot[] };
export type InvLedgerKind = 'add' | 'adjust' | 'count' | 'archive';
export type InvLedgerEntry = { seq: number; txnId: string; kind: InvLedgerKind; memberId: string; lotId: string; itemId: string; delta: number; qtyAfter: number; reason: string; createdAt: number };
export type InvLotResult = { lots: InvLot[]; replayed: boolean };
export type InventoryExport = InventoryState & { ledger: InvLedgerEntry[]; ledgerTruncated: boolean };
