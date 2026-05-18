# GitHub Marketplace Listing — Submission Guide

## Overview

This guide walks Craig through submitting GateTest to the GitHub Marketplace as a paid GitHub App listing.
Complete every step in order. The listing will be reviewed by GitHub staff (typically 3–7 business days).

---

## Prerequisites (confirm before starting)

- [ ] GitHub App **GateTestHQ** is already created under the `ccantynz-alt` organisation account
- [ ] The app is installed on at least one repository (required to publish)
- [ ] You are signed in to GitHub as the account that owns the app
- [ ] A 1544×500 px banner image is ready (PNG or JPEG — see `assets/banner-1544x500.txt`)
- [ ] A 256×256 px logo/icon is ready (PNG — see `assets/icon-256x256.txt`)
- [ ] At least 5 screenshots are captured (see `screenshots.md` for what to capture)
- [ ] Stripe is live (or you are using GitHub's native billing — see Step 7)

---

## Step 1 — Open the GitHub App settings

1. Go to **https://github.com/settings/apps** (or **https://github.com/organizations/ccantynz-alt/settings/apps** if the app is owned by the org).
2. Click **GateTestHQ**.
3. In the left sidebar, click **Marketplace listing**.
   - If you don't see this option, the app must first be installed on at least one repo. Install it on `crclabs-hq/gatetest` via the "Install App" tab.

---

## Step 2 — Fill in the basic listing details

On the **Marketplace listing** page:

| Field | Value |
|-------|-------|
| **Listing name** | GateTest — AI Code Quality |
| **Short description** | 67 AI-powered quality modules scan your repo on every PR. Security, performance, accessibility, and more. Issues found AND fixed automatically. |
| **Categories** | Code review · Testing · Security · Continuous integration |
| **Primary language** | (leave blank — GateTest is language-agnostic) |

Paste the **Full description** from `listing.md` into the long description field. GitHub Marketplace renders standard Markdown.

---

## Step 3 — Upload visual assets

| Asset | Spec | File to use |
|-------|------|-------------|
| App logo / icon | 200×200 px minimum, PNG | Create from `assets/icon-256x256.txt` spec |
| Banner image | 1544×500 px, PNG/JPEG | Create from `assets/banner-1544x500.txt` spec |
| Screenshots (×5) | 1280×800 px, PNG | See `screenshots.md` |

Upload images in the **Screenshots and video** section. Drag and drop screenshots in the order described in `screenshots.md`. Captions are optional but recommended — use the caption suggestions in that file.

---

## Step 4 — Configure app permissions and webhook events

Confirm these are already set on the GitHub App itself (under **Permissions & events**). If not, update them before submitting the listing.

**Repository permissions:**
| Permission | Access level |
|-----------|-------------|
| Contents | Read |
| Pull requests | Read & write |
| Commit statuses | Read & write |
| Issues | Read & write |
| Metadata | Read (mandatory, set automatically) |

**Webhook events:**
- `push`
- `pull_request`

**Setup URL:** `https://gatetest.ai/github/setup`
**Callback URL:** `https://gatetest.ai/api/github/callback`
**Webhook URL:** `https://gatetest.ai/api/webhook`

---

## Step 5 — Set the setup URL and post-installation flow

In the **Optional features** section of the App settings (not the Marketplace listing), confirm:

- **Setup URL (after installation):** `https://gatetest.ai/github/setup`
  - This is where GitHub redirects users immediately after they install the app.
  - The page at this URL should prompt them to select a scan tier and enter payment details.
- **Redirect on update:** `https://gatetest.ai/github/setup`

---

## Step 6 — Configure pricing plans

In the Marketplace listing editor, scroll to **Pricing and setup**. GitHub offers two billing models:

### Option A — GitHub-native billing (recommended for launch)

GitHub handles payments and remits to you monthly. Lower friction for users (one click — uses their existing GitHub payment method).

Click **Add a plan** for each tier:

| Plan name | Unit | Price | Description (shown to buyer) |
|-----------|------|-------|-------------------------------|
| Free | — | $0/month | 1 scan/month on public repos. No credit card required. |
| Quick Scan | per-use or flat | $29/month | Quick Scan (4 modules): security, secrets, syntax, lint. |
| Full Scan | per-use or flat | $99/month | All 67 AI-powered modules. Full report + SARIF output. |
| Scan + Fix | per-use or flat | $199/month | All 67 modules + automatic fix PR opened in your repo. |
| Continuous | flat | $49/month | Scan on every push. All 67 modules. Always-on protection. |

> **Note on per-use vs flat:** GitHub Marketplace currently supports flat-fee monthly/yearly plans and one-time charges via "per-unit" plans. For the one-time-per-scan model, select **per-unit** and set the unit label to "scan". Users purchase N scans upfront.

### Option B — Redirect to gatetest.ai (Stripe)

If you prefer to keep Stripe as the payment processor, set all Marketplace plans as **Free** and use the **Setup URL** (`https://gatetest.ai/github/setup`) to drive users to the Stripe checkout on your own site. This is a valid pattern and gives you full control over pricing and billing.

---

## Step 7 — Accept the Marketplace Developer Agreement

On the listing page, GitHub will prompt you to accept the **GitHub Marketplace Developer Agreement**. Read it, then click **Accept**.

This agreement covers revenue sharing (GitHub takes 0% as of 2024 for new listings). Verify the current terms before accepting.

---

## Step 8 — Submit for review

1. Scroll to the bottom of the Marketplace listing page.
2. Click **Submit for review**.
3. GitHub will email you within 3–7 business days with approval or feedback.

### Common rejection reasons and fixes:
| Rejection reason | Fix |
|-----------------|-----|
| "App must be installable" | Install the app on at least one repo first |
| "Description too short" | Full description must be 40+ words |
| "Missing screenshots" | Upload at least 1 screenshot (5 recommended) |
| "Webhook URL unreachable" | Ensure `https://gatetest.ai/api/webhook` returns 200 on a GET request (add a health-check handler if needed) |
| "Setup URL not responding" | Ensure `https://gatetest.ai/github/setup` loads without auth errors |
| "Pricing plans incomplete" | Each paid plan needs a description and unit price |

---

## Step 9 — After approval

Once approved:

1. The listing goes live at `https://github.com/marketplace/gatestesthq` (or similar slug).
2. GitHub sends you a confirmation email with the live URL.
3. Update `CLAUDE.md` Known Issue #29 to DONE.
4. Add the Marketplace badge to `website/app/page.tsx` and `README.md`:
   ```
   [![GitHub Marketplace](https://img.shields.io/badge/Marketplace-GateTest-blue?logo=github)](https://github.com/marketplace/gatestesthq)
   ```
5. Announce in any mailing list / social channels.

---

## Useful links

- GitHub Marketplace docs: https://docs.github.com/en/apps/publishing-apps-to-github-marketplace
- GitHub App settings: https://github.com/settings/apps
- Marketplace developer agreement: https://docs.github.com/en/site-policy/github-terms/github-marketplace-developer-agreement
- Support: partners@github.com
