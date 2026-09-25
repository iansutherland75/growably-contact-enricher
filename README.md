# Growably Contact Enricher

Fill in the blanks on your Growably (GoHighLevel) contacts, and get a one-page pre-meeting brief before a sales call.

Built by an MSP for MSPs. It runs on your own Cloudflare account, sits behind Cloudflare Access sign-in, and costs a few dollars a month to run. Setup is done in the browser. No terminal, no code changes.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/iansutherland75/growably-contact-enricher)

Setup takes 30 to 45 minutes. Follow [SETUP.md](SETUP.md).

## What it does

Point it at a contact and it fills in what is missing, without overwriting anything you already have. When it finds a different value for a field that is already filled, it shows you both and lets you choose.

| It finds | Where from |
|---|---|
| First and last name (fixes ALL CAPS, fills blanks) | Email address, LinkedIn |
| LinkedIn profile | Apollo.io, Brave Search |
| Job title | Apollo.io, LinkedIn |
| Company name, website, phone, address | The company's own website |
| Employee count | Apollo.io |
| Mobile number | Apollo.io (arrives a minute or two after enrichment) |
| Email status: valid, invalid, unknown | Apollo.io. Invalid addresses get the email DND flag in Growably |
| Twitter / X profile | Brave Search |
| Sector tag: healthcare, legal, accounting, insurance, nonprofit, general | Company name, domain and title |

Three ways to run it:

- **Add Contact**: type an email address, get a new enriched contact.
- **Enrich Contact**: search, preview the current record, enrich with one click.
- **Bulk Enrich** (administrators): every contact, contacts created since a date, or contacts with a tag. Runs in the background in batches of ten every five minutes.

**Generate Brief** researches the person, the company and their sector, then writes a one-page pre-meeting brief with Claude or ChatGPT and saves it as a note on the contact. Sections: the 30-second picture, the person, the organization, their likely IT environment, industry context, hypothesized pain points, angles for your company, questions to ask, things to avoid, sources.

## What you need

| | Notes |
|---|---|
| **Cloudflare account** | Free. Bulk enrichment needs the Workers Paid plan (USD 5 a month). Sign-in uses Cloudflare Zero Trust, free for up to 50 users. |
| **GitHub account** | Free. The Deploy button copies this project into your GitHub so Cloudflare can build it. |
| **Growably** | Your existing sub-account and a Private Integration token. |
| **Apollo.io** | Any plan with API access. Each enrichment spends credits; phone reveals cost more. |
| **Brave Search API** | The free tier (2,000 queries a month) covers light use. An enrichment uses two to six queries, a brief uses five. |
| **Anthropic or OpenAI API key** | Optional. Only the brief uses it. A brief costs a few cents. |
| **Microsoft 365** | For sign-in. The setup guide covers Microsoft Entra ID as the identity provider. |

## How it works

One Cloudflare Worker serves the web app and the API. Cloudflare Access sits in front of it (one click on the worker's Access tab), so nobody reaches the page without signing in, and the worker checks the signed-in identity again on every request.

Out of the box it uses Growably's own palette: orange for buttons and the active menu item, blue for links and labels, navy for the sidebar. Administrators can swap in their own logo and colours under Settings.

The first person to sign in after deployment chooses the administrators and pastes in the API keys. Keys are encrypted with a secret only your worker holds (`CONFIG_KEY`) before they are stored, and the app never shows a key in full again. Administrators can change keys, users, branding and the brief profile under Settings. Everyone else gets Add Contact and Enrich Contact.

## What it writes to Growably

**Custom fields**, created for you from Settings with one click: LinkedIn URL, Twitter URL, Job Title, Company Domain, Mobile Number, Employee Count, Email Status, Enrich Date, Enrich Error.

**Standard fields**, only when empty: first name, last name, company name, website, phone, address, city, state or province, postal code, country.

**Tags**: `email-valid`, `email-invalid`, `email-unknown`, `sector-healthcare` and the other sector tags, and `nurture` when you press the Nurture button.

**Notes**: one per brief.

**DND**: email DND is switched on when Apollo reports the address as bounced.

## Data and privacy

To enrich a contact, the worker sends the contact's email address, name and company to Apollo.io and Brave Search, and fetches the company's public website. To write a brief, it also sends the contact details and the search results to your chosen AI provider. Nothing is stored outside your Cloudflare account and your Growably account, apart from whatever those providers keep under their own terms.

Your API keys live in Cloudflare KV, encrypted with `CONFIG_KEY`. Anyone who can open your Cloudflare dashboard can see that an encrypted value exists, not what it says.

## Limitations

- One Growably location per install. Run a second copy for a second location.
- Address parsing understands Canadian and US formats. Other countries still get name, website and phone.
- Bulk enrichment needs the Workers Paid plan. The Free plan caps subrequests and a batch stops after two or three contacts.
- Updates are manual. The Deploy button makes a copy of this project in your GitHub account. To pick up changes from here, copy them across.

## For developers

```
src/index.js     routes, auth middleware, setup and admin endpoints, cron
src/enrich.js    the enrichment pipeline
src/brief.js     the pre-meeting brief
src/ai.js        Anthropic and OpenAI, chosen at setup
src/fields.js    Growably custom field discovery and creation
src/config.js    runtime config: encrypted KV secrets with wrangler fallbacks
src/crypto.js    AES-GCM for stored keys, derived webhook token
src/branding.js  branding and brief profile storage
src/ghl.js       Growably API helpers
src/access.js    Cloudflare Access JWT verification
frontend/        plain HTML, CSS and JavaScript, no build step
```

Local development:

```bash
npm install
cp .dev.vars.example .dev.vars   # set CONFIG_KEY and DEV_AUTH_EMAIL
npx wrangler dev
```

`DEV_AUTH_EMAIL` skips sign-in locally. Never set it in production.

Deploy from a terminal instead of the button:

```bash
npx wrangler login
npx wrangler deploy                      # creates the KV namespace on first run
npx wrangler secret put CONFIG_KEY
npx wrangler secret put ACCESS_TEAM_DOMAIN
npx wrangler secret put ACCESS_APP_AUD
```

Then continue from step 2 of [SETUP.md](SETUP.md).

## License

MIT. See [LICENSE](LICENSE).

Written by Ian Sutherland. Questions and fixes are welcome as GitHub issues and pull requests.
