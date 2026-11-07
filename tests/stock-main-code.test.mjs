import assert from "node:assert/strict";
import { stockMainCode } from "../js/stock-sizes.js";

assert.equal(stockMainCode("AA28", [{ base: "AA", size: "28", qty: 2 }]), "AA");
assert.equal(stockMainCode("AA29", [{ base: "aa", size: "29", qty: 1 }]), "AA");
assert.equal(stockMainCode("E100", [{ base: "", size: "M", qty: 3 }]), "E100");
assert.equal(stockMainCode("A256", []), "A256");
assert.equal(stockMainCode("ZZ30", [{ base: "ZZ" }, { base: "OTHER" }]), "ZZ30");

console.log("stock-main-code tests passed");
