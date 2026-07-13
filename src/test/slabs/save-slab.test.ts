import { describe, it, expect } from "vitest";
import { saveSlab, validateSlabInput } from "@/lib/slabs/save-slab";
import { normalizeImageExt } from "@/lib/slabs/constants";
import { makeMockDao, validInput, image } from "./helpers";

describe("saveSlab — duplicate certification (grader-scoped, normalized)", () => {
  it("rejects a duplicate certification and reports the existing inventory number", async () => {
    // Seeded by composite key GRADER:CERT (validInput's default grader is PSA).
    const { dao } = makeMockDao({ existingCerts: { "PSA:000123": 7 } });
    const result = await saveSlab(validInput({ certification_number: "000123" }), image(), image(), dao);
    expect(result.status).toBe("duplicate");
    if (result.status === "duplicate") expect(result.existing_inventory_number).toBe(7);
  });

  it("never creates a second row with the same certification", async () => {
    const { dao, state } = makeMockDao();
    const first = await saveSlab(validInput({ certification_number: "ABC999" }), image(), image(), dao);
    const second = await saveSlab(validInput({ certification_number: "ABC999" }), image(), image(), dao);
    expect(first.status).toBe("success");
    expect(second.status).toBe("duplicate");
    expect(state.createdNumbers).toHaveLength(1); // only one row created
  });

  it("treats the SAME cert number under DIFFERENT graders as distinct (not a duplicate)", async () => {
    const { dao, state } = makeMockDao();
    const psa = await saveSlab(validInput({ grader: "PSA", certification_number: "12345678" }), image(), image(), dao);
    const cgc = await saveSlab(validInput({ grader: "CGC", certification_number: "12345678" }), image(), image(), dao);
    expect(psa.status).toBe("success");
    expect(cgc.status).toBe("success");
    expect(state.createdNumbers).toHaveLength(2);
  });

  it("treats whitespace/case-different certs under the same grader as duplicates", async () => {
    const { dao, state } = makeMockDao();
    const first = await saveSlab(validInput({ grader: "PSA", certification_number: "abc 123" }), image(), image(), dao);
    const second = await saveSlab(validInput({ grader: "psa", certification_number: "ABC123" }), image(), image(), dao);
    expect(first.status).toBe("success");
    expect(second.status).toBe("duplicate");
    expect(state.createdNumbers).toHaveLength(1);
  });

  it("preserves leading zeros — '000123' and '123' are different certs", async () => {
    const { dao, state } = makeMockDao();
    const a = await saveSlab(validInput({ grader: "PSA", certification_number: "000123" }), image(), image(), dao);
    const b = await saveSlab(validInput({ grader: "PSA", certification_number: "123" }), image(), image(), dao);
    expect(a.status).toBe("success");
    expect(b.status).toBe("success");
    expect(state.createdNumbers).toHaveLength(2);
  });
});

describe("saveSlab — sequential & concurrent numbering", () => {
  it("assigns sequential inventory numbers from the database, not the browser", async () => {
    const { dao } = makeMockDao();
    const a = await saveSlab(validInput({ certification_number: "C1" }), image(), image(), dao);
    const b = await saveSlab(validInput({ certification_number: "C2" }), image(), image(), dao);
    const c = await saveSlab(validInput({ certification_number: "C3" }), image(), image(), dao);
    const nums = [a, b, c].map((r) => (r.status === "success" ? r.slab.inventory_number : -1));
    expect(nums).toEqual([1, 2, 3]);
  });

  it("gives concurrent creations distinct sequential numbers", async () => {
    const { dao, state } = makeMockDao();
    const results = await Promise.all(
      Array.from({ length: 5 }, (_, i) =>
        saveSlab(validInput({ certification_number: `CC${i}` }), image(), image(), dao),
      ),
    );
    const nums = results
      .filter((r): r is Extract<typeof r, { status: "success" }> => r.status === "success")
      .map((r) => r.slab.inventory_number)
      .sort((x, y) => x - y);
    expect(nums).toEqual([1, 2, 3, 4, 5]);
    expect(new Set(state.createdNumbers).size).toBe(5); // all unique
  });
});

describe("saveSlab — failure cleanup", () => {
  it("cleans up the row and images when the FRONT upload fails", async () => {
    const { dao, state } = makeMockDao({ failUpload: "front" });
    const result = await saveSlab(validInput(), image(), image(), dao);
    expect(result.status).toBe("error");
    expect(state.deletedRows).toEqual(["slab-1"]); // row removed
    expect(state.deletedImages).toContain("slabs/1/front.jpg"); // partial image removed
  });

  it("cleans up the row and both images when the BACK upload fails", async () => {
    const { dao, state } = makeMockDao({ failUpload: "back" });
    const result = await saveSlab(validInput(), image(), image(), dao);
    expect(result.status).toBe("error");
    expect(state.deletedRows).toEqual(["slab-1"]);
    expect(state.deletedImages).toEqual(expect.arrayContaining(["slabs/1/front.jpg", "slabs/1/back.jpg"]));
  });

  it("does NOT upload images when the database insert fails (no incomplete record)", async () => {
    const { dao, state } = makeMockDao({ createError: { message: "db exploded" } });
    const result = await saveSlab(validInput(), image(), image(), dao);
    expect(result.status).toBe("error");
    expect(state.uploads).toHaveLength(0); // nothing uploaded
    expect(state.deletedRows).toHaveLength(0); // nothing to roll back
  });

  it("succeeds and returns the completed slab when everything works", async () => {
    const { dao, state } = makeMockDao();
    const result = await saveSlab(validInput(), image("png"), image("png"), dao);
    expect(result.status).toBe("success");
    if (result.status === "success") {
      expect(result.slab.inventory_number).toBe(1);
      expect(result.slab.front_image_path).toBe("slabs/1/front.png");
    }
    expect(state.uploads).toEqual(["slabs/1/front.png", "slabs/1/back.png"]);
    expect(state.deletedRows).toHaveLength(0);
  });
});

describe("saveSlab — optional back image", () => {
  it("succeeds with only a front image — some slabs carry all needed data on the front label alone", async () => {
    const { dao, state } = makeMockDao();
    const result = await saveSlab(validInput(), image(), null, dao);
    expect(result.status).toBe("success");
    if (result.status === "success") {
      expect(result.slab.front_image_path).toBe("slabs/1/front.jpg");
      expect(result.slab.back_image_path).toBeNull();
    }
    // Only the front was uploaded — no back upload attempted at all.
    expect(state.uploads).toEqual(["slabs/1/front.jpg"]);
  });

  it("does not require a back image to pass validation", () => {
    const errors = validateSlabInput(validInput(), true, false);
    expect(errors).toEqual([]);
  });

  it("still cleans up correctly when the front upload fails and no back was provided", async () => {
    const { dao, state } = makeMockDao({ failUpload: "front" });
    const result = await saveSlab(validInput(), image(), null, dao);
    expect(result.status).toBe("error");
    expect(state.deletedRows).toEqual(["slab-1"]);
    expect(state.deletedImages).toEqual(["slabs/1/front.jpg"]); // no back path to clean up
  });

  it("still rejects when the FRONT image is missing (front stays required)", () => {
    const errors = validateSlabInput(validInput(), false, false);
    expect(errors).toEqual(expect.arrayContaining(["Front image is required."]));
  });
});

describe("image extension validation (mirrors SQL valid_image_ext)", () => {
  it("accepts the allow-list and tolerates a leading dot / uppercase", () => {
    expect(normalizeImageExt("JPG")).toBe("jpg");
    expect(normalizeImageExt(".PNG")).toBe("png");
    expect(normalizeImageExt("heic")).toBe("heic");
  });
  it("rejects unsupported extensions, blanks, separators, and traversal", () => {
    for (const bad of ["gif", "", "  ", "jpg/../x", "png\\x", "../evil", "svg"]) {
      expect(normalizeImageExt(bad)).toBeNull();
    }
  });
  it("blocks a save with an unsupported extension before any DB write", async () => {
    const { dao, state } = makeMockDao();
    const result = await saveSlab(validInput(), image("gif"), image(), dao);
    expect(result.status).toBe("validation_error");
    expect(state.createdNumbers).toHaveLength(0);
    expect(state.uploads).toHaveLength(0);
  });
  it("blocks a save with a path-traversal extension", async () => {
    const { dao, state } = makeMockDao();
    const result = await saveSlab(validInput(), { blob: new Blob(["x"]), ext: "../evil" }, image(), dao);
    expect(result.status).toBe("validation_error");
    expect(state.createdNumbers).toHaveLength(0);
  });
  it("blocks a save with an unsupported BACK extension even though back is optional", async () => {
    const { dao, state } = makeMockDao();
    const result = await saveSlab(validInput(), image(), image("gif"), dao);
    expect(result.status).toBe("validation_error");
    expect(state.createdNumbers).toHaveLength(0);
  });
});

describe("saveSlab — validation", () => {
  it("requires card name, grader, grade, certification, and the front image", () => {
    const errors = validateSlabInput(
      { ...validInput(), card_name: "", grader: "", grade: "", certification_number: "" },
      false,
      false,
    );
    expect(errors).toEqual(
      expect.arrayContaining([
        "Card name is required.",
        "Grader is required.",
        "Grade is required.",
        "Certification number is required.",
        "Front image is required.",
      ]),
    );
    expect(errors).not.toContain("Back image is required.");
  });

  it("blocks save on validation error before touching the database", async () => {
    const { dao, state } = makeMockDao();
    const result = await saveSlab(validInput({ card_name: "" }), image(), image(), dao);
    expect(result.status).toBe("validation_error");
    expect(state.createdNumbers).toHaveLength(0);
  });
});
