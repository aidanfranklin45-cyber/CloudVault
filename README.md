CloudVaultCloudVault is an unstaffed, hybrid valet storage platform designed to optimize personal inventory storage for users who need flexible, short-term capacity without paying for full-sized self-storage units. The platform features an interactive, pay-per-item staging engine, integrated customer onboarding workflows, and an administrative employee backend for automated multi-location operations.  Key FeaturesPay-Per-Item Cost Estimator: Interactive pricing calculator allowing users to estimate storage costs based on individual item volume rather than fixed unit sizing.  Automated Single-Day Staging Access: Secure PIN-code system for unstaffed staging facilities, facilitating flexible drop-offs and pickups.  Relational Schema & Fine-Grained Security: Built on Supabase (PostgreSQL) with Row-Level Security (RLS) policies to enforce Role-Based Access Control (RBAC) across customers and facility managers.  Multi-Location Employee Portal: Dedicated administrative dashboard for tracking physical item movement, managing inventory status, and overseeing site operations across multiple staging hubs.  Product Analytics & Telemetry: Integrated PostHog API tracking to monitor onboarding funnel conversion and detect edge-case workflow failures.  Tech StackFrontend: TypeScript, Web/Mobile Framework (Flutter / React)  Backend & Database: Supabase (PostgreSQL with RLS, PostgREST), Node.js  Authentication & Auth Pipelines: Supabase Auth with custom RBAC middleware  Analytics & Telemetry: PostHog API  DevOps & Workflows: Docker, Agentic Engineering via Google Antigravity  System Architecture[ Customer Web/Mobile App ] ---> [ Interactive Staging Calculator ]
                                               |
                                               v
                                [ PostHog Telemetry Pipeline ]
                                               |
                                               v
[ Employee Admin Portal ] <---> [ Supabase / PostgreSQL (RLS) ]
                                               |
                                               v
                                [ Single-Day PIN Staging Gate ]
Getting StartedPrerequisitesNode.js (v18+)  Docker Desktop  Supabase CLI  InstallationClone the repository:Bashgit clone https://github.com/aidanfranklin45-cyber/cloudvault.git
cd cloudvault
Install dependencies:Bashnpm install
Configure Environment Variables:Create a .env.local file in the project root:Code snippetNEXT_PUBLIC_SUPABASE_URL=your_supabase_url
NEXT_PUBLIC_SUPABASE_ANON_KEY=your_supabase_anon_key
SUPABASE_SERVICE_ROLE_KEY=your_supabase_service_role_key
NEXT_PUBLIC_POSTHOG_KEY=your_posthog_api_key
NEXT_PUBLIC_POSTHOG_HOST=https://app.posthog.com
Initialize Local Database & Migrations:Bashnpx supabase start
npx supabase db reset
Run the Development Server:Bashnpm run dev
Database Migration & Security NoteCloudVault initially utilized Firestore for rapid prototyping but was migrated to Supabase (PostgreSQL) to support strict Role-Based Access Control (RBAC) via native Row-Level Security (RLS) policies. All database tables require explicit RLS definitions for customer data isolation and employee permissions.
