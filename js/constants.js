// ============================================================================
// constants.js — single source of truth for enums used across the app.
// Add a size or type here and it shows up everywhere (matrix generator,
// filters, badges) without touching other files.
// ============================================================================

// Sizes are type-specific: shirts use letter sizes, pants use waist
// numbers, accessories are usually one-size. Add/change values here and
// it applies everywhere (product form, filters).
export const SIZES_BY_TYPE = {
  SHIRT: ["S", "M", "L", "XL", "2XL", "3XL", "4XL", "5XL"],
  PANTS: ["28", "29", "30", "31", "32", "34", "36"],
  ACCESSORY: ["One Size"],
};

export const VARIANT_TYPES = Object.keys(SIZES_BY_TYPE);

// Every distinct size across all types — used for the top-level search
// filter dropdown, which isn't tied to a single type.
export const SIZES = [...new Set(Object.values(SIZES_BY_TYPE).flat())];

export function sizesForType(type) {
  return SIZES_BY_TYPE[type] || SIZES;
}

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
    status: "STORED", // STORED = in the storage location below; SHOWN = currently out on the live/showroom floor
    location: "",        // PRIMARY storage bin code for the actual sellable stock, e.g. "A1"
    sample_location: "", // where the single sample/display piece lives — separate from the bulk stock above, since it's kept out for reference/show rather than sold from
    ...overrides,
  };
}

// Storage bin suggestions for the Live tab's location field (A1–A14).
// It's a free-text field so any code (including ones outside this list,
// like a second row B1–B14) still works — this just powers autocomplete.
export const STORAGE_LOCATIONS = Array.from({ length: 14 }, (_, i) => `A${i + 1}`);
