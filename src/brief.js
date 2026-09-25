/**
 * Pre-meeting sales brief.
 *
 * Runs a handful of Brave searches and an MX lookup in parallel, hands the
 * research to the configured AI provider with a structured prompt, and saves
 * the result as a note on the Growably contact. The rep, company and region
 * come from the brief profile an admin fills in under Settings.
 */

import { ghlPost } from './ghl.js';
import { braveSearch, inferSector } from './enrich.js';
import { generateText } from './ai.js';
import { getBranding, getBriefProfile } from './branding.js';
import { resolveFieldIds } from './fields.js';

// ─── Sector research queries ──────────────────────────────────────────────────

/**
 * Brave query that surfaces regulatory, threat and budget context for the
 * prospect's sector in the MSP's own region, so the brief reads as local.
 */
function sectorContextQuery(sector, region, year) {
  const base = {
    healthcare: 'healthcare IT privacy compliance managed services cybersecurity',
    legal:      'law firm IT security compliance managed services',
    accounting: 'accounting firm CPA IT security cloud',
    insurance:  'insurance industry IT cybersecurity compliance',
    nonprofit:  'nonprofit IT technology funding security',
    smb:        'small business IT managed services cybersecurity',
  }[sector] ?? 'small business IT managed services cybersecurity';
  return `${base} ${region} ${year}`.replace(/\s+/g, ' ').trim();
}

// ─── Brief profile → system prompt ───────────────────────────────────────────

function splitLines(text) {
  return String(text ?? '')
    .split('\n')
    .map(s => s.trim().replace(/^[-•*]\s*/, ''))
    .filter(Boolean);
}

/**
 * Build the analyst instructions from the admin-entered brief profile.
 * Every place the old prompt named a specific rep or company now reads from
 * the profile, with neutral fallbacks when a field is blank.
 */
function buildSystemPrompt(profile) {
  const rep     = profile.repName || 'the sales rep';
  const company = profile.companyName || 'our company';
  const region  = profile.region || 'the prospect\'s region';
  const diffs   = splitLines(profile.differentiators);
  const anglesHeading = `${company.toUpperCase()} ANGLES`;

  const aboutBlock = profile.companyDescription
    ? `About ${company}: ${profile.companyDescription}\n\n`
    : `About ${company}: a managed IT services provider.\n\n`;

  const diffBlock = diffs.length
    ? `${company}'s key differentiators (use these in the ${anglesHeading} section):\n${diffs.map(d => `- ${d}`).join('\n')}\n\n`
    : '';

  return `You are a B2B sales intelligence analyst preparing a pre-meeting brief for ${rep} at ${company}.

${aboutBlock}${diffBlock}OUTPUT FORMAT: Produce exactly these sections in this order. Use plain prose or bullet points as specified. Never use dashes anywhere in the output. Use bullets (dot characters) only.

30-SECOND PICTURE
3 to 4 sentences. Who is this person and org, what is the most important thing to know walking in, and what is the single angle most likely to open the conversation. This should read like a briefing to a busy executive.

THE PERSON
4 to 6 bullets covering: role and scope of authority, tenure in current position, career background, any public writing or speaking, and whether they appear to be new to the role (new leaders often drive technology change).

THE ORGANIZATION
4 to 6 bullets covering: what the org does, approximate size, location, recent news or announcements, and any notable context relevant to an IT conversation.

THEIR LIKELY IT ENVIRONMENT
3 to 4 bullets. Label every inference explicitly with "likely," "probably," or "unclear." Cover: Microsoft 365 vs Google Workspace, whether a current MSP relationship is visible, cloud posture, and whether their infrastructure appears ahead of or behind average for their sector and size. If an Email platform (MX) value is provided in the contact data, state it as a confirmed fact rather than an inference.

INDUSTRY CONTEXT
One paragraph. What is this sector dealing with right now from an IT and security perspective in ${region}? Reference real pressures: regulatory, threat landscape, staffing, budget cycles. Do not be generic.

HYPOTHESIZED PAIN POINTS
3 bullets. Each bullet must follow this exact format: state the hypothesis, then state the question ${rep} should ask to validate it. Example format: "Hypothesis sentence. Question to ask: open-ended question here."

${anglesHeading}
2 to 3 bullets. Connect ${company}'s specific strengths to this prospect's actual situation. Be concrete about why each angle fits this org, not just what ${company} offers.

QUESTIONS TO ASK
5 to 7 open questions mixing discovery, advisory, and forward-looking. Number them.

THINGS TO AVOID
1 to 3 bullets flagging anything sensitive, potentially awkward, or off-limits based on the research. If nothing to flag, omit this section entirely.

SOURCES
List URLs for the key research items used. One per line.

TONE AND RULES:
- Write in plain direct language
- Never use dashes
- Label confirmed facts versus inferences explicitly using "likely," "probably," or "unclear"
- Never fabricate. If a section cannot be researched, say so briefly and lean harder on industry context
- The goal is 3 to 4 things ${rep} can say or ask that make them sound like they have been paying attention to this prospect's world for months
- Keep the whole brief to one printed page`;
}

/** Format a timestamp in the profile's timezone, falling back to UTC. */
function localTimestamp(timezone) {
  const opts = { hour12: true };
  try {
    return new Date().toLocaleString('en-CA', { ...opts, timeZone: timezone || 'UTC' });
  } catch {
    return new Date().toLocaleString('en-CA', { ...opts, timeZone: 'UTC' });
  }
}

// ─── MX provider detection ────────────────────────────────────────────────────

/**
 * Resolve MX records for a domain using Cloudflare's DNS-over-HTTPS API and
 * identify the email platform. Called only in generateBrief (not during enrichment)
 * so it doesn't add latency to the main enrichment pipeline.
 *
 * Result is passed to Claude as a confirmed fact - "Email platform (MX): Microsoft 365"
 * - so the brief can state it as known rather than as an inference.
 *
 * Detects:
 *   Microsoft 365   - mail.protection.outlook.com / .outlook.com MX records
 *   Google Workspace - google.com / googlemail.com MX records
 *   Zoho Mail        - zoho.com MX records
 *   Mimecast         - often fronts Microsoft 365 (common in mid-market)
 *   Proofpoint       - often fronts Microsoft 365 (common in enterprise/healthcare)
 *   Unknown          - returns the raw MX host so the brief still has something useful
 */
async function resolveMXProvider(domain) {
  try {
    const res = await fetch(
      `https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(domain)}&type=MX`,
      { headers: { Accept: 'application/dns-json' } }
    );
    if (!res.ok) return null;
    const data = await res.json();
    const records = (data?.Answer ?? [])
      .filter(r => r.type === 15)
      .map(r => (r.data ?? '').toLowerCase());

    if (records.length === 0) return null;

    if (records.some(r => r.includes('mail.protection.outlook.com') || r.includes('.outlook.com'))) return 'Microsoft 365';
    if (records.some(r => r.includes('google.com') || r.includes('googlemail.com'))) return 'Google Workspace';
    if (records.some(r => r.includes('zoho.com'))) return 'Zoho Mail';
    if (records.some(r => r.includes('mimecast.com'))) return 'Mimecast (likely Microsoft 365)';
    if (records.some(r => r.includes('pphosted.com') || r.includes('proofpoint.com'))) return 'Proofpoint (likely Microsoft 365)';

    const host = records[0].split(/\s+/).pop().replace(/\.$/, '');
    return `Unknown (MX: ${host})`;
  } catch {
    return null;
  }
}

// ─── Pre-meeting brief ────────────────────────────────────────────────────────

/**
 * Generate a pre-meeting sales brief and save it as a note on the contact.
 *
 * Process:
 *   1. Run up to 5 Brave searches (person background, sector context, org news,
 *      tech signals, MSP signals) and an MX record lookup in parallel
 *   2. Format the research into a structured prompt
 *   3. Call the configured AI provider with a system prompt built from the brief profile
 *   4. Prepend a header with contact info, meeting stage, and timestamp
 *   5. Save the finished brief as a Growably note on the contact
 *
 * `env` must be the resolved runtime env from config.js.
 * options: { meetingDate, meetingStage, focusNotes } from the frontend form.
 */
export async function generateBrief(contact, options, env) {
  const t0 = Date.now();
  const [fieldIds, profile, branding] = await Promise.all([
    resolveFieldIds(env), getBriefProfile(env), getBranding(env),
  ]);

  const { meetingDate = '', meetingStage = 'first meeting', focusNotes = '' } = options ?? {};

  const name       = `${contact.firstName ?? ''} ${contact.lastName ?? ''}`.trim();
  const email      = contact.email ?? '';
  const domain     = email.includes('@') ? email.split('@')[1] : null;
  const company    = contact.companyName ?? '';

  // Read a custom field value from the contact object. An unresolved field ID
  // simply finds nothing.
  const cfVal      = (id) => (id ? contact.customFields?.find(f => f.id === id)?.value ?? null : null);
  const linkedIn   = cfVal(fieldIds.linkedinUrl);
  const jobTitle   = cfVal(fieldIds.jobTitle) || contact.jobTitle || '';
  const compDomain = cfVal(fieldIds.companyDomain) || domain || '';
  const year       = new Date().getFullYear();

  const freeMail   = ['gmail.com','yahoo.com','hotmail.com','outlook.com','icloud.com','live.com','me.com'];
  const isFreeMail = domain ? freeMail.includes(domain.toLowerCase()) : true;
  const sector     = inferSector(company, compDomain, jobTitle);

  // ── MX lookup + research in parallel ──────────────────────────────────────
  // All searches run simultaneously to keep total latency to ~2s instead of ~10s
  let mxProvider = null;
  const searchGroups = [];
  const searches = [
    // MX lookup - only meaningful for business domains
    !isFreeMail && compDomain
      ? resolveMXProvider(compDomain).then(r => { mxProvider = r; }).catch(() => {})
      : Promise.resolve(),

    // Person background: career, tenure, LinkedIn activity
    braveSearch(`"${name}" ${company || compDomain} career background linkedin`, env, 5)
      .then(r => searchGroups.push({ label: 'PERSON', results: r?.web?.results ?? [] }))
      .catch(() => {}),

    // Sector IT context in the MSP's region: regulatory pressures, threat landscape, budget cycles
    braveSearch(sectorContextQuery(sector, profile.region, year), env, 5)
      .then(r => searchGroups.push({ label: 'SECTOR', results: r?.web?.results ?? [] }))
      .catch(() => {}),
  ];

  if (!isFreeMail && compDomain) {
    searches.push(
      // Org news: recent announcements, leadership changes, funding
      braveSearch(`"${company || compDomain}" news announcement ${year - 1} ${year}`, env, 5)
        .then(r => searchGroups.push({ label: 'ORG NEWS', results: r?.web?.results ?? [] }))
        .catch(() => {}),

      // Tech signals: job postings reveal current stack (M365, Azure, etc.)
      braveSearch(`"${company || compDomain}" hiring IT technology microsoft 365 azure security`, env, 5)
        .then(r => searchGroups.push({ label: 'TECH SIGNALS', results: r?.web?.results ?? [] }))
        .catch(() => {}),

      // MSP signals: is there a visible existing IT/MSP relationship?
      braveSearch(`"${company || compDomain}" "managed services" OR "IT support" OR "microsoft partner" OR "google workspace"`, env, 3)
        .then(r => searchGroups.push({ label: 'MSP SIGNALS', results: r?.web?.results ?? [] }))
        .catch(() => {}),
    );
  }

  await Promise.all(searches);

  // Format research for the model - include URLs so it can populate the Sources section
  const researchBlock = searchGroups.map(g =>
    `[${g.label}]\n` + g.results.slice(0, 4).map(r =>
      `  Title: ${r.title}\n  URL: ${r.url ?? ''}\n  Snippet: ${r.description ?? ''}`
    ).join('\n')
  ).join('\n\n');

  // ── Contact context block ────────────────────────────────────────────────
  // Everything we know about the contact, passed to the model as structured text.
  // mxProvider is a confirmed fact, not an inference, so the model can state it directly.
  const contactBlock = [
    `Name: ${name}`,
    jobTitle   ? `Title: ${jobTitle}`     : null,
    `Email: ${email}`,
    company    ? `Company: ${company}`    : null,
    compDomain ? `Domain: ${compDomain}`  : null,
    contact.website  ? `Website: ${contact.website}` : null,
    contact.phone    ? `Phone: ${contact.phone}`      : null,
    contact.address1 ? `Location: ${[contact.address1, contact.city, contact.state, contact.postalCode, contact.country].filter(Boolean).join(', ')}` : null,
    linkedIn         ? `LinkedIn: ${linkedIn}`          : null,
    mxProvider       ? `Email platform (MX): ${mxProvider}` : null,
    `Inferred sector: ${sector}`,
  ].filter(Boolean).join('\n');

  const meetingBlock = [
    meetingDate  ? `Meeting date: ${meetingDate}`       : null,
    `Meeting stage: ${meetingStage}`,
    focusNotes   ? `Focus notes from rep: ${focusNotes}` : null,
  ].filter(Boolean).join('\n');

  const systemPrompt = buildSystemPrompt(profile);

  const userMsg = `Generate the pre-meeting brief.

CONTACT AND MEETING DETAILS:
${contactBlock}

${meetingBlock}

RESEARCH FINDINGS:
${researchBlock || '(no external research available - base brief on contact data and sector context)'}`;

  // ── Call the AI provider ─────────────────────────────────────────────────
  // Reasoning models spend output tokens thinking before they write, so leave
  // room well beyond the one-page brief. Effort is medium: at high the call
  // ran over a minute against the browser's 100 s edge timeout, and a brief
  // does not need deep reasoning.
  const aiStart = Date.now();
  const ai = await generateText({ system: systemPrompt, user: userMsg, maxTokens: 8000, effort: 'medium' }, env);
  console.log(`[brief] ${contact.id} provider=${ai.provider} model=${ai.model} stop=${ai.stopReason} ` +
    `in=${ai.usage?.input} out=${ai.usage?.output} ` +
    `research=${aiStart - t0}ms ai=${Date.now() - aiStart}ms`);
  const briefBody = ai.text;

  // Prepend a structured header so the note is scannable in Growably
  const timestamp = localTimestamp(profile.timezone);
  const stageLine = meetingStage ? ` | ${meetingStage.toUpperCase()}` : '';
  const dateLine  = meetingDate  ? ` | ${meetingDate}` : '';
  const header    = `PRE-MEETING BRIEF\n${name.toUpperCase()}${company ? ` | ${company.toUpperCase()}` : ''}${stageLine}${dateLine}\nGenerated by ${branding.appName} on ${timestamp}\n\n`;
  const fullBrief = header + briefBody;

  // Save as a Growably note, visible in the contact timeline under Activities
  await ghlPost(`/contacts/${contact.id}/notes`, { body: fullBrief }, env);
  return { contactId: contact.id, name, noteLength: fullBrief.length, brief: fullBrief };
}
