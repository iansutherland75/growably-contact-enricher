# Setup

Everything here happens in a web browser. Budget 30 to 45 minutes. You need to be an administrator of your Growably sub-account and of your Microsoft 365 tenant.

## Before you start

Have these ready. Each takes a minute or two to find.

**Growably token and location ID**

1. In Growably, open your sub-account, then Settings, then Private Integrations.
2. Create a new integration. Name it "Contact Enricher". Scopes: contacts (read and write), locations (read), custom fields (read and write). Copy the token. It is shown once.
3. The Location ID is under Settings, Business Profile, near the bottom.

**Apollo.io API key**

In Apollo: Settings, Integrations, API. Create a key. Enrichment spends credits, so check your plan's credit allowance.

**Brave Search API key**

Sign up at https://api.search.brave.com. Choose the Data for Search plan. The free tier is enough to start. Create a key and copy it.

**AI key (optional)**

For briefs only. Either an Anthropic key from https://console.anthropic.com/settings/keys or an OpenAI key from https://platform.openai.com/api-keys. Both are pay per use with no monthly fee.

**A long random string**

You will be asked for a `CONFIG_KEY`. Any 32 or more random characters will do. A password manager's generator is the easiest way to make one. Keep a copy. If you lose it you only have to re-enter the API keys, but keep it anyway.

## Step 1: Deploy

1. Click the Deploy to Cloudflare button in the README.
2. Sign in to Cloudflare, or create a free account.
3. Connect your GitHub account when asked. Cloudflare copies this project into a new repository under your account and builds from there.
4. On the setup form, keep the default names. Fill in the three secrets:
   - `CONFIG_KEY`: paste your random string.
   - `ACCESS_TEAM_DOMAIN`: type `pending` for now.
   - `ACCESS_APP_AUD`: type `pending` for now.
5. Click Create and deploy. The first build takes a minute or two.
6. When it finishes, note your app's address. It looks like `https://growably-contact-enricher.YOURNAME.workers.dev`.
7. Open that address. You should see a page that says "Sign-in is not set up yet". That is correct at this stage.

## Step 2: Turn on sign-in

Cloudflare Access puts a sign-in page in front of the app. It is free for up to 50 users.

**2a. Enable Access on the app**

1. In the Cloudflare dashboard, go to Workers & Pages and open your worker.
2. Open Settings, then Domains & Routes. On newer dashboards this is the Domains tab.
3. Next to the `workers.dev` route, click Enable Cloudflare Access.
4. The first time, Cloudflare asks you to set up Zero Trust. Choose a team name. It becomes your team domain, for example `acme-it.cloudflareaccess.com`. Pick the Free plan. Cloudflare asks for a payment method even on the Free plan; it is not charged.
5. When asked who may sign in, allow only your own email address for now. You will widen this in step 7.

**2b. Copy the two values the worker needs**

1. Team domain: in Zero Trust, go to Settings, then Custom Pages. Copy the team domain. It ends in `.cloudflareaccess.com`.
2. Audience tag: in Zero Trust, go to Access, then Applications. Open the application named after your worker. On its overview, copy the Application Audience (AUD) Tag. It is a 64-character string.

**2c. Give them to the worker**

1. Back in Workers & Pages, open your worker, then Settings, then Variables and Secrets.
2. Edit `ACCESS_TEAM_DOMAIN` and paste the team domain.
3. Edit `ACCESS_APP_AUD` and paste the audience tag.
4. Save. Cloudflare redeploys the worker on its own.

**2d. Let Apollo's phone webhook through**

Apollo sends mobile numbers to the app a minute or two after each enrichment. It cannot sign in, so one address needs a hole in the sign-in wall. This is safe: that address checks its own secret token.

1. In Zero Trust, go to Access, then Applications, then Add an application, then Self-hosted.
2. Name it "Contact Enricher webhook".
3. Under the application domain, enter your worker's hostname (for example `growably-contact-enricher.YOURNAME.workers.dev`) and the path `api/apollo-webhook`.
4. Add a policy. Name it "Apollo". Set the action to Bypass. Under Include, choose Everyone.
5. Save the application.

**2e. Sign in with Microsoft 365**

By default Access offers a one-time PIN by email. To sign in with Microsoft 365 accounts instead:

1. In Zero Trust, go to Settings, then Authentication, then Login methods, then Add new, then Azure AD.
2. Follow Cloudflare's guide, which walks through creating an app registration in Microsoft Entra: https://developers.cloudflare.com/cloudflare-one/integrations/identity-providers/entra-id/
3. Back in Access, open your worker's application, then Authentication, and select only Azure AD.

You can do this step later. One-time PIN works fine for the rest of setup.

## Step 3: First sign-in

1. Open your app's address and sign in.
2. The setup screen appears. Only the first person to sign in sees it.
3. Administrators: your email is filled in. Add anyone else who should manage the tool, one per line.
4. Paste the Growably token and location ID, then click Test. You should see "Works" and your location name.
5. Paste the Apollo key and the Brave key. Test each.
6. Optional: choose an AI provider, paste its key and Test it.
7. Optional: give the tool a name. The default is Lead Enrichment.
8. Click Finish setup. The page reloads into the app.

If a yellow box says `CONFIG_KEY` is not set, the secret from step 1 did not take. The box shows a fresh value and where to paste it in the Cloudflare dashboard. Do that, wait a minute, reload, and continue.

## Step 4: Create the Growably fields

Enrichment writes to nine custom fields. The app creates them for you.

1. Open Settings in the left sidebar.
2. Find the Growably fields card. Every row says Missing.
3. Click Create missing fields. A few seconds later every row says Exists.

If you already have a field called Job Title or Employee Count, the app uses it instead of creating a duplicate.

## Step 5: Brief profile and branding

Both are on the Settings page.

**Brief profile** tells the AI who the brief is for. Fill in the rep's name, your company name, one line on what you do, your region, and a few differentiators, one per line. Set the timezone so brief timestamps read correctly.

**Branding** sets the name in the sidebar and browser tab, a logo, and a brand colour.

## Step 6: Try one contact

1. Open Enrich Contact. Search for someone you know.
2. Click Enrich now. In 10 to 20 seconds the table shows what was found. Open the contact in Growably to see the fields and tags.
3. If you added an AI key, click Generate Brief. It takes 30 to 60 seconds and saves the brief as a note on the contact.

A "Mobile: arriving" tag means Apollo is still looking up the number. It lands on the contact a minute or two later through the webhook from step 2d.

## Step 7: Let your team in

1. In Zero Trust, go to Access, then Applications, open your worker's application, then Policies.
2. Edit the Allow policy. Change the Include rule from your email address to Emails ending in `@yourdomain.com`.
3. Anyone at your domain can now sign in. They start as a User: Add Contact and Enrich Contact only.
4. To make someone an administrator, open Settings, then User Management, and change their role. You can also add them before they first sign in.

## Optional

**Bulk enrichment** needs the Workers Paid plan. In the Cloudflare dashboard, go to Workers & Pages, then Plans, and upgrade. Then redeploy once (Workers & Pages, your worker, Deployments, Retry the latest deployment) so the new limits apply. On the Free plan each bulk batch stops after two or three contacts.

**Custom domain.** If your domain is on Cloudflare, open your worker's Domains tab and add a hostname such as `enrich.yourdomain.com`. Then repeat step 2 for that hostname: enable Access on it, create the webhook bypass for it, and update `ACCESS_APP_AUD` if Cloudflare created a new Access application.

**Updates.** The Deploy button made a copy of this project in your GitHub account. To take changes from the original, compare the two repositories on GitHub and copy the files that changed. Pushing to your repository's main branch redeploys automatically.

## Something wrong?

See [OPERATIONS.md](OPERATIONS.md) for the common problems and how to read the logs.
