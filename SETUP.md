# Setup guide

Everything in this guide happens in a web browser. No terminal, no code. Budget 30 to 45 minutes.

You need to be an administrator of your Growably sub-account and of your Microsoft 365 tenant, and you need a payment card for the Cloudflare Zero Trust free plan (it asks for one, it does not charge it).

## What you will do

| Step | What happens | Time |
|---|---|---|
| 0 | Collect the accounts and keys listed below | 10 min |
| 1 | Click Deploy to Cloudflare | 5 min |
| 2 | Turn on sign-in with Cloudflare Access | 10 min |
| 3 | Sign in, choose administrators, paste keys | 5 min |
| 4 | Create the Growably fields with one click | 1 min |
| 5 | Fill in the brief profile and branding | 5 min |
| 6 | Enrich one contact | 2 min |
| 7 | Let your team in | 2 min |

At the end you have your own copy of the tool running in your own Cloudflare account, protected by Microsoft 365 sign-in, connected to your Growably sub-account.

## Step 0: Before you start

Collect the following. Keep them in a text file or password manager while you work.

**Accounts**

- A Cloudflare account. Free at https://dash.cloudflare.com/sign-up.
- A GitHub account. Free at https://github.com/signup. The Deploy button copies this project into your GitHub so Cloudflare can build it.

**Growably token and location ID**

1. In Growably, open your sub-account, then Settings, then Private Integrations.
2. Click Create new integration. Name it "Contact Enricher". Under scopes, tick contacts (read and write), locations (read), and custom fields (read and write). Save and copy the token. Growably shows it once.
3. The Location ID is under Settings, Business Profile, near the bottom of the page.

**Apollo.io API key**

1. Sign in at https://app.apollo.io. Open Settings (the gear icon, bottom left), then Integrations, then API Keys.
2. Click Create new key and give it a name, such as "Contact Enricher".
3. Apollo asks which endpoints the key may use. Tick two: People Enrichment (the `people/match` call, under People) and the auth Health check. Or turn on "Set as master key" to allow everything.
4. Click Create and copy the key.

Every enrichment spends Apollo credits, and mobile numbers spend more. Check your allowance under Settings, Plans and Billing.

**Brave Search API key**

1. Sign up at https://api.search.brave.com.
2. Choose the Data for Search plan. The free tier covers light use.
3. Create a key and copy it.

**AI key (optional, for briefs only)**

Either an Anthropic key from https://console.anthropic.com/settings/keys or an OpenAI key from https://platform.openai.com/api-keys. Both are pay per use. A brief costs a few cents. OpenAI accounts need credits loaded first (Settings, Organization, Billing); a new account with no credits is rejected with "no credits".

**One random string**

You will be asked for a `CONFIG_KEY`. Any 32 or more random characters. A password manager's generator is the easiest way to make one. Keep a copy. It encrypts your API keys; if you lose it you re-enter the keys in Settings, nothing worse.

## Step 1: Deploy

1. Click the Deploy to Cloudflare button in the README.
2. Sign in to Cloudflare. Connect your GitHub account when asked.
3. The form asks for a repository name and a worker name. Keep the defaults. It also asks for three secrets:
   - `CONFIG_KEY`: paste your random string.
   - `ACCESS_TEAM_DOMAIN`: type `pending`. You will replace it in step 2.
   - `ACCESS_APP_AUD`: type `pending`. Same.
4. Click Create and deploy. The first build takes a minute or two.
5. When it finishes, note your app's address. It looks like `https://growably-contact-enricher.YOURNAME.workers.dev`.

**Check:** open that address. You should see a page that says "Sign-in is not set up yet", with the same instructions as step 2 below. Correct at this point.

## Step 2: Turn on sign-in

Cloudflare Access puts a sign-in page in front of the app. It is free for up to 50 users. There are three parts: protect the worker, give the worker two values, and open one gap for Apollo's phone webhook.

**2a. Protect the worker**

1. In the Cloudflare dashboard, go to Workers & Pages and open your worker.
2. Open the Access tab and click Protect this Worker behind Access.
3. First time only: Cloudflare asks you to set up Zero Trust. Choose a team name. It becomes your team domain, for example `acme-it.cloudflareaccess.com`. Pick the Free plan and add the payment card when asked.
4. In the dialog that opens: under Scope choose All traffic. Under Authentication policy, open Add policy and choose Email domain. Enter the domain of the email addresses your team signs in with, for example `acme-it.com`.
5. Click Apply Access.

Use the domain of your Microsoft 365 email addresses here. If your website is on a different domain, that one will not work: sign-in would say "That account does not have access".

**Check:** the Access tab now shows Worker Access, All traffic, your email domain policy, and a box called Application values with an AUD tag and a JWKS URL. Leave this tab open.

**2b. Give the two values to the worker**

1. Open the worker's Settings tab, then Variables and Secrets.
2. Edit `ACCESS_APP_AUD`. Paste the AUD tag from the Access tab. It is a 64-character string.
3. Edit `ACCESS_TEAM_DOMAIN`. Paste the JWKS URL from the Access tab. The worker keeps only the host part, so `https://acme-it.cloudflareaccess.com/cdn-cgi/access/certs` and `acme-it.cloudflareaccess.com` both work.
4. Save. Cloudflare redeploys the worker on its own.

**2c. Let Apollo's phone webhook through**

Apollo sends mobile numbers to the app a minute or two after each enrichment. Apollo cannot sign in, so one address needs a gap in the sign-in wall. This is safe: that address checks its own secret token, and Cloudflare applies a hostname rule ahead of the worker rule, which is why the gap works.

1. In the Cloudflare dashboard, go to Zero Trust, then Access controls, then Applications, then Create new application.
2. Leave Self-hosted and private selected. Click Continue with Self-hosted and private.
3. Under Public hostnames, click Switch to custom input. In the single box that appears, enter your worker's hostname followed by the path, for example `growably-contact-enricher.YOURNAME.workers.dev/api/apollo-webhook`.
4. Scroll down to Access policies and click Create new policy. Fill in:
   - Policy Name: `Apollo webhook bypass`
   - Include rule: set the selector to Everyone
   - Action: Bypass
   Click Save policy. The policy appears in the table with the word Bypass.
5. Scroll to the bottom. The application name is filled in for you. Click Create.

**Check:** go back to the worker's Access tab and reload it. A Hostname policies section now lists `/api/apollo-webhook` with the Apollo webhook bypass policy above your Worker Access rule.

**2d. Sign in with Microsoft 365**

By default Access offers a one-time PIN sent by email. To sign in with Microsoft 365 accounts instead:

1. In Zero Trust, go to Team & Resources, then Authentication, then Login methods, then Add new, then Azure AD.
2. Follow Cloudflare's guide, which walks through creating an app registration in Microsoft Entra: https://developers.cloudflare.com/cloudflare-one/integrations/identity-providers/entra-id/
3. Back in Zero Trust, open Access controls, Applications, the application named after your worker, then the Authentication tab, and select only Azure AD.

You can do this later. The one-time PIN works for the rest of setup.

## Step 3: First sign-in

1. Open your app's address and sign in.
2. The setup screen appears. Only the first person to sign in sees it.
3. Administrators: your email is filled in. Add anyone else who should manage the tool, one per line. Administrators run bulk jobs and change users, keys, fields and branding. Everyone else gets Add Contact and Enrich Contact.
4. Growably: paste the token and location ID, then click Test. Expect "Works" and your location name.
5. Apollo and Brave: paste each key and click Test.
6. AI (optional): choose Anthropic or OpenAI, paste the key, Test.
7. Optional: give the tool a name. The default is Lead Enrichment.
8. Click Finish setup. The page reloads into the app.

If a yellow box says `CONFIG_KEY` is not set, the secret from step 1 did not take. The box shows a fresh value and where to paste it in the Cloudflare dashboard (your worker, Settings, Variables and Secrets, Add, type Secret, name `CONFIG_KEY`). Do that, wait a minute, reload, and continue.

## Step 4: Create the Growably fields

Enrichment writes to eight custom fields. The app creates them for you.

1. Open Settings in the left sidebar.
2. Find the Growably fields card. Rows for fields you do not have yet say Missing.
3. Click Create missing fields. A few seconds later every row says Exists, and the banner at the top of the app disappears.

If your sub-account already has a field with the same name, such as Job Title or Employee Count, the app uses it instead of making a duplicate.

## Step 5: Brief profile and branding

Both cards are on the Settings page.

**Brief profile** tells the AI who the brief is for: the rep's name, your company name, one line on what you do, your region, a few differentiators (one per line), and your timezone. Without it the brief still works but reads generic.

**Branding** sets the name in the sidebar and browser tab, a logo, and the two colours. The defaults follow Growably's palette.

## Step 6: Enrich one contact

1. Open Enrich Contact and search for someone you know.
2. Click Enrich now. After 10 to 20 seconds the table shows what was found in green. Open the contact in Growably to see the fields and the sector tag.
3. Where the tool found a different value for a field you already had, the row shows an Overwrite button. Nothing is overwritten unless you click it.
4. If you added an AI key, click Generate Brief. It takes 30 to 60 seconds and saves the brief as a note on the contact.

A "Mobile: arriving" tag means Apollo is still looking up the number. It lands on the contact a minute or two later through the gap from step 2c. Shared mailboxes such as `office@` or `info@` rarely get a mobile number because Apollo has no person to match.

## Step 7: Let your team in

Anyone with an email at the domain from step 2a can already sign in. They arrive as Users: Add Contact and Enrich Contact only.

To make someone an administrator, open Settings in the app, then User Management, and change their role. You can add them there before they first sign in.

## Optional

**Bulk enrichment** needs the Cloudflare Workers Paid plan (USD 5 a month). In the Cloudflare dashboard go to Workers & Pages, then Plans, and upgrade. Then redeploy once so the new limits apply: your worker, Deployments, Retry on the latest deployment. On the Free plan each bulk batch stops after two or three contacts.

**Custom domain.** If your domain is on Cloudflare, open your worker's Domains tab and add a hostname such as `enrich.yourdomain.com`. The Worker Access rule from step 2a covers the new hostname. Add a second webhook bypass application (step 2c) for `enrich.yourdomain.com/api/apollo-webhook`, then sign in once at the new address so the app learns it.

**Updates.** The Deploy button made a copy of this project in your GitHub account. To take changes from the original, compare the two repositories on GitHub and copy the files that changed. Pushing to your repository's main branch redeploys automatically.

## If something does not look right

| You see | Cause | Fix |
|---|---|---|
| "Sign-in is not set up yet" after step 2 | One of the two Access values is blank, still `pending`, or malformed | Step 2b again. Wait a minute and reload. |
| "That account does not have access" on the Cloudflare sign-in page | The Access policy domain does not match the email you signed in with | Worker's Access tab, Manage access, change the Email domain to your sign-in domain. |
| "Your sign-in could not be verified" | The AUD tag does not match the worker's Access application | Re-copy the AUD tag from the Access tab into `ACCESS_APP_AUD`. |
| Test says the Growably token was rejected | Wrong token, or a scope missing | Create a new Private Integration with the scopes from step 0. |
| Test says the AI account has no credits | OpenAI account without prepaid credits | Add credits under Settings, Organization, Billing at platform.openai.com. |
| Banner says Growably fields are missing | Step 4 not done yet | Settings, Growably fields, Create missing fields. |
| "Mobile: arriving" never arrives | Step 2c missing, or Apollo has no number | Check the Hostname policies section on the worker's Access tab shows the bypass. |

More in [OPERATIONS.md](OPERATIONS.md), including logs and what to do if the only administrator leaves.
