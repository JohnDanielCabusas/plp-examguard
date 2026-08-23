# PLP ExamGuard

PLP ExamGuard is a Capstone project designed to support secure and fair online examination environments. The system helps instructors manage exams, monitor suspicious activity, record violations, and review student submissions with clear audit trails and warning logic.

The goal of this project is to provide a practical solution for digital assessment integrity by combining exam administration, monitoring, and review workflows in one platform.

## Project Overview

This application is intended for environments where online assessments need stronger accountability and oversight. It supports:

- exam session management
- student activity and violation tracking
- review and dismissal of violation evidence
- warning and submission logic for exam attempts
- secure handling of assessment outcomes

The system is designed to help protect academic integrity while still giving instructors a manageable workflow for reviewing cases.

## Tech Stack

The project uses a modern web application stack focused on reliability, speed, and ease of deployment:

- Frontend: React / Next.js
- Language: TypeScript
- Styling: Tailwind CSS
- Backend: Node.js / API routes
- Database: PostgreSQL via Supabase
- Authentication: Supabase Auth
- Deployment: Vercel or similar hosting platform
- Version Control: Git / GitHub

> If your team is using a slightly different frontend or backend setup, update the stack listed here to match the exact implementation in your repository.

## Prerequisites

Before installing and running the system, make sure you have:

- Node.js 18 or newer
- npm or yarn
- Git
- A Supabase account or local Supabase instance
- A browser for testing the UI

For Windows users, install Node.js from the official website and use PowerShell or Command Prompt for commands.

## Installation

1. Clone the repository

```powershell
git clone https://github.com/your-username/plp-examguard.git
cd plp-examguard
```

2. Install dependencies

```powershell
npm install
```

If you use Yarn:

```powershell
yarn install
```

3. Configure environment variables

Create a `.env.local` file in the project root and add the required project settings. Typical variables may include:

```env
NEXT_PUBLIC_SUPABASE_URL=your_supabase_project_url
NEXT_PUBLIC_SUPABASE_ANON_KEY=your_supabase_anon_key
SUPABASE_SERVICE_ROLE_KEY=your_supabase_service_role_key
NEXT_PUBLIC_APP_URL=http://localhost:3000
```

If your project uses a different environment naming convention, follow the configuration already defined in the app.

4. Set up the database

If you are using Supabase:

- create a Supabase project
- connect your project to the repository
- apply the SQL migration scripts in the `supabase/` folder
- verify that the required tables and triggers are created successfully

If you are running Supabase locally, start the local Supabase environment before testing the app.

Example:

```powershell
npx supabase start
```

## Running the Application

### Development mode

```powershell
npm run dev
```

Then open:

```text
http://localhost:3000
```

### Production build

```powershell
npm run build
npm run start
```

This compiles the app and serves the production build locally.

## Useful Commands

```powershell
npm run lint
npm run test
npm run build
```

Use these commands to validate the application before deployment.

## Notes

This project is intended as a Capstone solution and is best suited for demonstration, testing, and academic evaluation. As the project evolves, the monitoring logic, review workflow, and security rules can be extended to support additional assessment scenarios.

## Contact

If you need to contact the project team, use the project repository or your assigned Capstone group communication channel.
