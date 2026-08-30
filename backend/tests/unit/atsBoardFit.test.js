import { describe, it, expect } from "vitest";
import { boardFitsCompany } from "../../lib/ingest/atsIngest.js";

/**
 * A slug that exists is not proof it is this company's job board.
 *
 * Every rejected case below is a real production lead: a Berlin restaurant
 * whose name shares a word with a US tech company, probed as that company's
 * board, and scored to the top of the list as "hiring ML engineers in
 * Seattle". The board's own job locations are the evidence that settles it.
 */
const job = (location, remote = false) => ({ title: "x", location, remote });

describe("boardFitsCompany — is this the company's board or a namesake's", () => {
  it("rejects a board whose jobs are all in another country", () => {
    const fit = boardFitsCompany(
      { slug: "haus", jobs: [job("Seattle, WA"), job("New York"), job("San Francisco, CA")] },
      { countryCode: "DE", city: "Berlin" },
    );
    expect(fit.ok).toBe(false);
    expect(fit.reason).toMatch(/none in Germany/);
  });

  it("rejects the Bay Area board found for a Berlin restaurant", () => {
    const fit = boardFitsCompany(
      { slug: "aida", jobs: [job("Bay Area (Palo Alto)"), job("Bay Area (Palo Alto)")] },
      { countryCode: "DE", city: "Berlin" },
    );
    expect(fit.ok).toBe(false);
  });

  it("accepts a board with at least one job in the company's country, however it is written", () => {
    for (const location of ["Berlin, Germany", "Berlin, Berlin, Germany", "München", "Deutschland", "Cologne, DE"]) {
      expect(boardFitsCompany({ jobs: [job("Austin, TX"), job(location)] }, { countryCode: "DE", city: "Hamburg" }).ok, location).toBe(true);
    }
    expect(boardFitsCompany({ jobs: [job("Dubai, UAE")] }, { countryCode: "AE", city: "Dubai" }).ok).toBe(true);
    expect(boardFitsCompany({ jobs: [job("Riyadh")] }, { countryCode: "SA", city: "Jeddah" }).ok).toBe(true);
    expect(boardFitsCompany({ jobs: [job("London, United Kingdom")] }, { countryCode: "GB", city: "Manchester" }).ok).toBe(true);
  });

  it("accepts a remote job as possibly local", () => {
    expect(boardFitsCompany({ jobs: [job("US-Remote", true)] }, { countryCode: "DE", city: "Berlin" }).ok).toBe(true);
  });

  it("fails open when there is nothing to judge on", () => {
    // No country on the company, or no locations on the board: the old
    // behaviour stands rather than a guess.
    expect(boardFitsCompany({ jobs: [job("Seattle, WA")] }, { countryCode: null, city: null }).ok).toBe(true);
    expect(boardFitsCompany({ jobs: [job(null), job("")] }, { countryCode: "DE", city: "Berlin" }).ok).toBe(true);
    expect(boardFitsCompany({ jobs: [] }, { countryCode: "DE" }).ok).toBe(true);
  });

  it("does not let a country code match inside another word", () => {
    // "DE" must not match "Delaware" or "Denver"; "US" must not match "Austin".
    expect(boardFitsCompany({ jobs: [job("Denver, CO")] }, { countryCode: "DE", city: "Berlin" }).ok).toBe(false);
    expect(boardFitsCompany({ jobs: [job("Austin, TX")] }, { countryCode: "US", city: "Austin" }).ok).toBe(true);
  });
});
