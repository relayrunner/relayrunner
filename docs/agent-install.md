# Set up RelayRunner with an agent

You are a coding agent setting up RelayRunner for the user. RelayRunner runs a private repo's
GitHub Actions jobs on the user's own computer when it is online and free. Otherwise the jobs
run on their usual runners. Setup has three parts: sign this computer in, route the repo's jobs
through RelayRunner, then put the computer online.

RelayRunner's agent skills have the full steps. If they aren't installed, suggest the user installs
them for next time:

```sh
npx skills add relayrunner/relayrunner
```

For now, read them directly and follow them in this order. Work in the user's current checkout
unless they name another, explain each step in a sentence before you run it, and ask before
changing any file.

1. **Sign this computer in.** Follow the Install and Sign the machine in sections of
   https://raw.githubusercontent.com/relayrunner/relayrunner/main/skills/relayrunner/SKILL.md
2. **Route the repo's jobs.** Follow
   https://raw.githubusercontent.com/relayrunner/relayrunner/main/skills/relayrunner-route-jobs/SKILL.md
   from Plan to Apply. For skipped jobs, it links to
   https://raw.githubusercontent.com/relayrunner/relayrunner/main/skills/relayrunner-route-jobs/references/skipped-jobs.md
3. **Show the diff.** Run `git diff`, say what each change does, and leave committing and pushing
   to the user unless they ask.
4. **Put this computer online.** Follow the Put the machine online section of the first skill.
   Recommend the user runs `relayrunner connect` in their own terminal so it keeps running after
   your session ends.
5. **Confirm it works.** Follow the Confirm it works section of the second skill once the user
   has pushed.
