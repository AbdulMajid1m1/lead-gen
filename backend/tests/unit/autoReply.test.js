import { describe, it, expect } from "vitest";
import { classifyAutoReply } from "../../lib/outreach/autoReply.js";

/**
 * Machine answers must not count as replies. The cases below are the real
 * ones from production on 2026-09-02, plus the shapes Gmail, Outlook and the
 * common help desks produce. The other direction is pinned just as hard: a
 * person's short answer must never be filed as automatic.
 */
describe("classifyAutoReply", () => {
  it("recognises Menufy's help-desk acknowledgement — the Bombay Bistro case", () => {
    const res = classifyAutoReply({
      from: "info@menufy.com",
      subject: "[Request received] ordering from Bombay Bistro",
      body: "##- Please type your reply above this line -##\n\nYour request (8115635) has been received and is being reviewed by our Menufy Support Team. We will try and get back to you as soon as we can! To add any additional comments, just reply to this email. In the meantime, check out our Menufy Help Center. Thanks! Menufy Support Team\n--------------------------------\nThis email is a service from Menufy. [LLJ3VE-VXN9R]",
      headers: "In-Reply-To: <abc@leadsignal.local>",
    });
    expect(res.isAutoReply).toBe(true);
    expect(res.kind).toBe("TICKET_ACK");
    expect(res.ticketId).toBe("8115635");
    expect(res.platform).toMatchObject({ domain: "menufy.com" });
  });

  it("recognises the second, terser ticket-created notice too", () => {
    const res = classifyAutoReply({
      from: "info@menufy.com",
      subject: "ordering from Bombay Bistro",
      body: "##- Please type your reply above this line -##\n\nA new request (8115635) has been created. To add additional comments, reply to this email.\n\nThis email is a service from Menufy. [LLJ3VE-VXN9R]",
    });
    expect(res.isAutoReply).toBe(true);
    expect(res.kind).toBe("TICKET_ACK");
  });

  it("recognises a German receipt confirmation — the Carambar case", () => {
    const res = classifyAutoReply({
      from: "info@carambar.de",
      subject: "Carambar Restaurant",
      body: "Sehr geehrte Damen und Herren, Vielen Dank für Ihre Email. Mit dieser Antwort bestätigen wir den Eingang Ihrer E-Mail. Bitte beachten sie, dass es sich hierbei um keine persönliche Antwort, sondern um eine automatisierte Email handelt. Unser Team wird sich Ihrer Angelegenheit annehmen.",
    });
    expect(res.isAutoReply).toBe(true);
    expect(res.kind).toBe("AUTO_ACK");
    expect(res.platform).toBeNull();
  });

  it("trusts the RFC 3834 header on its own", () => {
    const res = classifyAutoReply({
      from: "jane@example-dental.co.uk",
      subject: "Re: your website",
      body: "Thanks for your email.",
      headers: "Auto-Submitted: auto-replied\nPrecedence: bulk",
    });
    expect(res.isAutoReply).toBe(true);
  });

  it("recognises out-of-office by subject and by body", () => {
    expect(classifyAutoReply({ subject: "Automatic reply: Customers can't find you online", body: "" }).kind).toBe("OUT_OF_OFFICE");
    expect(classifyAutoReply({ subject: "Out of Office", body: "I am currently out of the office with limited access to email and will respond on my return." }).kind).toBe("OUT_OF_OFFICE");
    expect(classifyAutoReply({ subject: "Abwesenheitsnotiz", body: "Ich bin bis 14.09. nicht im Büro." }).isAutoReply).toBe(true);
  });

  it("recognises Zendesk / Freshdesk shapes by header and by phrase", () => {
    expect(classifyAutoReply({ subject: "Re: hello", body: "Thanks", headers: "X-Zendesk-From-Account-Id: 1234" }).isAutoReply).toBe(true);
    expect(classifyAutoReply({ subject: "[#45012] Your enquiry", body: "Thank you for contacting Acme Support. Your ticket has been logged and a member of our team will respond shortly." }).kind).toBe("TICKET_ACK");
  });

  it("recognises a WhatsApp Business greeting, but not a person who opens with thanks", () => {
    expect(classifyAutoReply({ from: "923001234567", body: "Hi! Thanks for messaging us. We'll get back to you as soon as possible." }).isAutoReply).toBe(true);
    expect(classifyAutoReply({ from: "923001234567", body: "Thank you for contacting Al Noor Dental. We are currently outside our business hours and will respond when we open." }).isAutoReply).toBe(true);
    expect(classifyAutoReply({ from: "923001234567", body: "Thanks for your message, yes we are interested. Call me tomorrow." }).isAutoReply).toBe(false);
  });

  it("leaves a person's answer alone, however short or formal", () => {
    for (const body of [
      "yes interested",
      "Thanks for reaching out. Not right now, but keep me posted.",
      "Hi Zubair, we have received your email and would like to know more about pricing. Can you call me on Monday?",
      "I received your message — how much does it cost?",
      "Sorry, we're happy with our current website. Please remove us.",
      "Ja, gerne. Können Sie mir ein Angebot schicken?",
    ]) {
      const res = classifyAutoReply({ from: "owner@realbusiness.com", subject: "Re: Customers can't find you online", body });
      expect(res.isAutoReply, body).toBe(false);
    }
  });

  it("does not turn a real reply from the business's own domain into a platform verdict", () => {
    const res = classifyAutoReply({ from: "owner@junesallday.com", subject: "Re: ordering", body: "Sure, tell me more.", companyDomain: "junesallday.com" });
    expect(res.isAutoReply).toBe(false);
    expect(res.platform).toBeNull();
  });
});
