// ============================================================================
// constants.js — single source of truth for enums used across the app.
// Add a size or type here and it shows up everywhere (matrix generator,
// filters, badges) without touching other files.
// ============================================================================

export const SIZES = ["S", "M", "L", "XL", "2XL", "3XL", "4XL", "5XL"];

export const VARIANT_TYPES = ["SHIRT", "PANTS", "ACCESSORY"];

export const DEFAULT_CATEGORY_COLOR = "#6b7280";
export const DEFAULT_TAG_COLOR = "#3b82f6";

export function emptyVariant(overrides = {}) {
  return {
    pos_code: "",
    alternate_codes: [],
    type: "SHIRT",
    size: "M",
    color_name: "",
    color_hex: "#000000",
    stock_quantity: 0,
    price: 0,
    ...overrides,
  };
}
