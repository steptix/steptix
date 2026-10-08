# Web survey project

Steptix tests against public websites, written to find out how well Steptix
automates the open web. The site list, the logins to create and the scoring
rubric are in [docs/web-survey-sites.md](../../docs/web-survey-sites.md).

These tests are **not** part of any suite. `templates/init/tests/` is for apps
this repo controls, and `npm run test:live` never sees this folder. Run them by
hand, one at a time or a section at a time, at low volume: the sites belong to
other people.

```powershell
cd <checkout>\survey\web
Copy-Item .env.example .env   # then fill in the logins you created
node ..\..\dist\index.js run tests\section-c\c39-the-internet.md
```

Or open the folder in VS Code and run a file from Steptix.

## Layout

- `tests/section-c/`: one file per element-playground site, numbered as in
  the survey doc. Each one starts with a **Probes** line saying what it is
  there to find out, so a failure can be filed under the rubric's categories.
- `tests/section-c/attachments/`: files the upload steps use.
- `context/public-sites.md`: what the model is told about every site.
- `results/section-c-runs.md`: every section C run side by side, with what
  failed and why. Reports themselves go to `reports/`, which is gitignored.

## Recording a result

Write the run's outcome under the rubric in the survey doc. When a step had to
be reworded before it worked, keep both versions: the original wording is the
evidence of what Steptix could not understand.
