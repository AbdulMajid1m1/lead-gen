import { describe, it, expect } from "vitest";
import { __testables, emailMatchesName, classifySeniority, isGreetableName, looksLikeJobTitle } from "../../lib/extract/people.js";
import { firstNameOf } from "../../lib/research/compose.js";

const { looksLikePersonName, cleanTitle } = __testables;

/**
 * Who counts as a person.
 *
 * The regression this guards reached a real outreach email. The name test was a
 * blocklist anchored to the first word, so any two capitalised words on a page
 * became a contact — a Dubai school's site yielded "Performing Arts",
 * "REGISTRATION FEES" and "Affordable Fee" as people, and the composer greeted
 * one of them: "Hi Affordable,".
 *
 * Both directions matter. Letting rubbish through puts an absurd greeting in
 * front of a stranger; over-blocking quietly throws away the named contact that
 * makes an email worth sending at all. So the junk list and the real-name list
 * are asserted with equal weight.
 */

// Every one of these was actually written to CompanyPerson from a live crawl.
const NOT_PEOPLE = [
  "Performing Arts", "Visual Arts", "Middle YearsProgramme", "Primary YearsProgramme",
  "ADMISSIONS OPEN", "Student Life", "Beyond DAA", "Leading Innovation",
  "Multimedia Rooms", "Scholarship News", "REGISTRATION FEES", "Affordable Fee",
  "DRIVING COURSE PACKAGES", "Choose Your License Type", "High School", "Middle School",
  "Human Resource", "Primary School Secretary", "School Principal", "Registrar Email",
  "Director Email", "General Enquiries", "Stay Connected", "Useful Links", "School Tours",
  "Pastoral Care", "Student Support", "Reception Desk",
];

// Real people from the same crawls, plus surnames that collide with the
// blocklist and name particles that must not be mistaken for junk.
const REAL_PEOPLE = [
  "Mr. Tariq Atwan", "Hossam Kamel Swailam", "ELLEN S. AMARANTE", "Moustafa Salah Hassan",
  "Mr Heath Monk", "Mr Peter Bonner", "Ms. Suad Abu Harb", "Sarah Daya", "Ann Galorio",
  "Karen Grant", "Antony Koshy", "Emily Hopkinson", "Ahmed Al Mansouri",
  "Sarah Page", "John Best", "Maria van der Berg", "Jean-Luc Picard",
];

describe("looksLikePersonName", () => {
  it("rejects the page furniture a crawl mistakes for people", () => {
    const accepted = NOT_PEOPLE.filter(looksLikePersonName);
    expect(accepted, `wrongly accepted: ${accepted.join(", ")}`).toEqual([]);
  });

  it("keeps real names, including ones that collide with the blocklist", () => {
    // "Page" and "Best" are ordinary surnames and also navigation words, which
    // is why the anywhere-match list has to exclude words that are only ever
    // furniture — never words that are also names.
    const lost = REAL_PEOPLE.filter((n) => !looksLikePersonName(n));
    expect(lost, `wrongly rejected: ${lost.join(", ")}`).toEqual([]);
  });

  it("keeps multi-particle surnames", () => {
    // "der" was missing from the particle list, so this was discarded entirely.
    expect(looksLikePersonName("Maria van der Berg")).toBe(true);
    expect(looksLikePersonName("Ahmed bin Rashid")).toBe(true);
  });

  it("rejects words fused together by flattened markup", () => {
    expect(looksLikePersonName("Middle YearsProgramme")).toBe(false);
    // A doctor's qualifications run into the surname on clinic sites.
    expect(looksLikePersonName("Dr. Naeem HassanL.C.E.HHomoeopath")).toBe(false);
  });

  it("keeps names that legitimately carry an internal capital", () => {
    // The fused-word rule first rejected these outright, which would have
    // deleted real doctors from Gulf clinics along with the page furniture.
    for (const n of ["Dr. Ibrahim AlBusaidi", "Ahmed ElSayed", "John McDonald", "Ian MacArthur"]) {
      expect(looksLikePersonName(n), n).toBe(true);
    }
  });

  it("rejects a label made only of job words", () => {
    for (const label of ["School Principal", "Human Resource", "General Enquiries", "Office Manager"]) {
      expect(looksLikePersonName(label), label).toBe(false);
    }
  });

  it("still rejects the obvious shapes", () => {
    for (const bad of ["", null, undefined, "A", "Bob", "john smith", "Contact Us", "Team", "Call Now 0501234567"]) {
      expect(looksLikePersonName(bad), String(bad)).toBeFalsy();
    }
  });
});

describe("cleanTitle", () => {
  it("keeps real job titles", () => {
    for (const t of ["Principal/CEO", "Primary Principal", "Head of Math Department",
                     "Arabic Secretary and HR Coordinator", "Health & Safety Officer", "Managing Director"]) {
      expect(cleanTitle(t), t).toBe(t);
    }
  });

  it("rejects body copy that happened to sit under a heading", () => {
    // A title is one of the things that corroborates a name, so prose accepted
    // here promotes the heading above it into a person.
    for (const prose of [
      "Our innovation hub is where creativity meets design and students build things",
      "Take a suitable option for your budget",
      "What is day to day student life like",
    ]) {
      expect(cleanTitle(prose), prose).toBeNull();
    }
  });

  it("rejects a stray personal name where a title belongs", () => {
    expect(cleanTitle("Sarah Mitchell")).toBeNull();
  });

  it("rejects navigation text", () => {
    // "Learn More" sat under a heading and was accepted as a job title, which
    // corroborated "Pastoral Care" as a person.
    for (const cta of ["Learn More", "Read More", "Contact Us", "View Profile"]) {
      expect(cleanTitle(cta), cta).toBeNull();
    }
  });
});

describe("emailMatchesName", () => {
  it("matches the conventions a small business actually uses", () => {
    for (const addr of ["antony.koshy@x.ae", "akoshy@x.ae", "koshya@x.ae", "antony@x.ae", "koshy@x.ae"]) {
      expect(emailMatchesName(addr, "Antony Koshy"), addr).toBe(true);
    }
  });

  it("does not match an unrelated mailbox", () => {
    expect(emailMatchesName("info@x.ae", "Antony Koshy")).toBe(false);
    expect(emailMatchesName("admissions@x.ae", "Antony Koshy")).toBe(false);
  });
});

describe("firstNameOf", () => {
  it("greets the person, not their honorific", () => {
    // Schools and clinics publish staff as "Mr. Tariq Atwan" almost without
    // exception, and taking the first token opened the email with "Hi Mr.,".
    expect(firstNameOf("Mr. Tariq Atwan")).toBe("Tariq");
    expect(firstNameOf("Dr. Ibrahim AlBusaidi")).toBe("Ibrahim");
    expect(firstNameOf("Ms. Suad Abu Harb")).toBe("Suad");
    expect(firstNameOf("Prof Emily Hopkinson")).toBe("Emily");
    expect(firstNameOf("Eng. Ahmed Al Mansouri")).toBe("Ahmed");
  });

  it("leaves an ordinary name alone", () => {
    expect(firstNameOf("Sarah Daya")).toBe("Sarah");
  });

  it("returns something rather than nothing for an honorific-only string", () => {
    expect(firstNameOf("Dr.")).toBe("Dr");
    expect(firstNameOf("")).toBe("");
  });
});

describe("classifySeniority", () => {
  it("ranks an owner above an operations title", () => {
    expect(classifySeniority("Principal/CEO")).toBe("OWNER");
    expect(classifySeniority("Office Manager")).toBe("OPERATIONS");
  });
});

/**
 * The composer's last line of defence before "Hi PROSCIUTTO,".
 *
 * Every rejected example below was a real CompanyPerson row in production,
 * exported with its title exactly as stored.
 */
describe("isGreetableName / looksLikeJobTitle — what may be greeted by name", () => {
  it("accepts names shaped like names", () => {
    for (const n of ["Karen Grant", "Mr Robert Jennings", "Guven Ates", "Bradley Wright", "Sara Klein"]) {
      expect(isGreetableName(n), n).toBe(true);
    }
  });

  it("never greets a menu item, an event, a nav link or a heading", () => {
    // The composer's decision is name-shape AND role-title. Each pair below
    // is a real CompanyPerson row from production, title exactly as stored;
    // every one of them was being greeted by "first name".
    const greetable = (name, title) => isGreetableName(name) && looksLikeJobTitle(title);
    for (const [name, title] of [
      ["PROSCIUTTO FUNGHI", "£15.5"], ["Zen Sesshin", "29. August | 10:00 - 17:00"], ["DAY OUT", "Shop now"],
      ["LAMBERTS DOWNTOWN BARBECUE", "(512) 555 0100"], ["Areas Covered", "EC1, N1, WC1, N21 and more"],
      ["Charter Inclusions", "Captain, Crew, Fuel"], ["Texas-Style Catering", "catering"],
      ["ARC Glass Wrap", "Emergency epoxy putty"], ["Curating Excellence", "Elite destinations, curated"],
    ]) {
      expect(greetable(name, title), `${name} / ${title}`).toBe(false);
    }
    for (const [name, title] of [
      ["Karen Grant", "Bursar and ECA Coordinator"], ["Mr Robert Jennings", "Secondary Principal"], ["Guven Ates", "Director/Solicitor"],
    ]) {
      expect(greetable(name, title), `${name} / ${title}`).toBe(true);
    }
  });

  it("only counts a title that names a role", () => {
    expect(looksLikeJobTitle("Bursar and ECA Coordinator")).toBe(true);
    expect(looksLikeJobTitle("Secondary Principal")).toBe(true);
    expect(looksLikeJobTitle("Director/Solicitor")).toBe(true);
    expect(looksLikeJobTitle("£15.5")).toBe(false);
    expect(looksLikeJobTitle("29. August | 10:00 - 17:00")).toBe(false);
    expect(looksLikeJobTitle("Shop now")).toBe(false);
    expect(looksLikeJobTitle("Elite destinations, curated")).toBe(false);
    expect(looksLikeJobTitle("Captain, Crew, Fuel")).toBe(false);
    expect(looksLikeJobTitle("(512) 555 0100")).toBe(false);
    expect(looksLikeJobTitle("Emergency epoxy putty")).toBe(false);
  });
});
