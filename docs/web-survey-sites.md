# Web survey: 100 sites to test Steptix against

The goal is to find out how well Steptix automates the open web, not to
build a regression suite. Each site gets one `.md` test that exercises what
the site is good at, and each run is scored with the rubric at the end so the
results turn into framework work.

These tests drive third-party sites, so they must **not** go under
`templates/init/tests/`: that folder is for apps this repo controls (see
CLAUDE.md). They live in their own Steptix project,
[survey/web/](../survey/web/README.md). Run them by hand at low volume. They
are not part of `npm run test:live`.

Written so far: section C, in `survey/web/tests/section-c/`.

Every URL was checked on 2026-10-08 and returned HTTP 200. Sites that failed the
check were left out: Magento Luma, Juice Shop demo, nopCommerce, OpenCart,
EverShop, Gatling computer DB, testfire, vulnweb and QA Playground.

**Login** column:
- **create**: sign up for an account. See "Logins to create" below.
- **given**: the site prints demo credentials, or accepts any credentials.
- blank: no login needed.

## A. Shopping: cart, checkout and multi-page flows

| # | Site | URL | What it tests | Login |
|---|------|-----|---------------|-------|
| 1 | Swag Labs | https://www.saucedemo.com/ | login, sort, cart, checkout. `problem_user` and `performance_glitch_user` give a broken UI and a slow one | given |
| 2 | Automation Exercise | https://automationexercise.com/ | signup, cart, checkout, contact form with upload, ads | create |
| 3 | Tricentis Demo Web Shop | https://demowebshop.tricentis.com/ | register, cart, multi-step checkout | create |
| 4 | Automation Test Store | https://automationteststore.com/ | product options, account, checkout | create |
| 5 | TutorialsNinja | https://tutorialsninja.com/demo/ | OpenCart storefront: search, compare, wishlist | create |
| 6 | Demoblaze | https://www.demoblaze.com/ | modal login, JS alerts, SPA navigation | create |
| 7 | LambdaTest eCommerce Playground | https://ecommerce-playground.lambdatest.io/ | mega menu, filters, hover menus | create |
| 8 | BrowserStack Demo | https://bstackdemo.com/ | React store, dropdown login, filters | given |
| 9 | Rahul Shetty client store | https://rahulshettyacademy.com/client/ | register, cart, orders, toast messages | create |
| 10 | GreenKart | https://rahulshettyacademy.com/seleniumPractise/ | quantity steppers, cart totals, promo codes | |
| 11 | JPetStore | https://petstore.octoperf.com/ | old server-rendered app, register, order | create |
| 12 | Polymer Shop | https://shop.polymer-project.org/ | shadow DOM all the way down | |
| 13 | PrestaShop demo | https://demo.prestashop.com/ | iframe-hosted store, guest checkout | |
| 14 | Web Scraper test shop | https://webscraper.io/test-sites/e-commerce/allinone | pagination, "load more", extracting data | |
| 15 | Books to Scrape | https://books.toscrape.com/ | extracting a catalogue, paging through categories | |
| 16 | BlazeDemo | https://blazedemo.com/ | flight search, purchase form | |
| 17 | React Shopping Cart | https://react-shopping-cart-67954.firebaseapp.com/ | size filters, slide-out cart | |
| 18 | Sauce Demo (Shopify) | https://sauce-demo.myshopify.com/ | real Shopify theme, variants | |

## B. Business apps: banking, HR, CRUD and content

| # | Site | URL | What it tests | Login |
|---|------|-----|---------------|-------|
| 19 | ParaBank | https://parabank.parasoft.com/parabank/index.htm | register, open account, transfer, bill pay | create |
| 20 | XYZ Bank (GlobalSQA) | https://www.globalsqa.com/angularJs-protractor/BankingProject/ | AngularJS, pick a customer, deposit, withdraw | |
| 21 | Guru99 Bank | https://demo.guru99.com/V4/ | credentials are emailed to you, then manager CRUD | create |
| 22 | Zero Bank | http://zero.webappsecurity.com/ | plain HTTP, login, pay bills, money map | given |
| 23 | Applitools demo | https://demo.applitools.com/ | login, dashboard tables (visual checks) | given |
| 24 | OrangeHRM | https://opensource-demo.orangehrmlive.com/ | big SPA, autocomplete, date pickers, CRUD | given |
| 25 | CURA Healthcare | https://katalon-demo-cura.herokuapp.com/ | book an appointment, date picker, radio buttons | given |
| 26 | Restful Booker platform | https://automationintesting.online/ | B&B booking calendar, admin panel | given |
| 27 | Contact List App | https://thinking-tester-contact-list.herokuapp.com/ | register, contact CRUD, validation | create |
| 28 | Expand Testing Notes | https://practice.expandtesting.com/notes/app | register, notes CRUD, categories | create |
| 29 | Buggy Cars Rating | https://buggy.justtestit.org/ | register, vote, profile; deliberately buggy | create |
| 30 | Conduit (Bondar) | https://conduit.bondaracademy.com/ | RealWorld blog: articles, tags, follow | create |
| 31 | Conduit (RealWorld) | https://demo.realworld.show/ | a second build of the same spec | create |
| 32 | ngx-admin playground | https://playground.bondaracademy.com/ | Angular admin: forms, smart table, modals | |
| 33 | Gitea demo | https://demo.gitea.com/ | create a repo, an issue and a label; markdown editor | create |
| 34 | Moodle sandbox | https://sandbox.moodledemo.net/ | LMS, course editing; resets every hour | given |
| 35 | WordPress Playground | https://playground.wordpress.net/ | block editor, wp-admin running in-browser | given |
| 36 | Open Library | https://openlibrary.org/ | search, reading lists, lists | create |
| 37 | Practice Test Automation | https://practicetestautomation.com/practice-test-login/ | login with positive and negative cases | given |
| 38 | Demo Automation Testing | https://demo.automationtesting.in/Register.html | long registration form, multi-select, Windows/Frames pages | |

## C. Element playgrounds: one tricky control after another

| # | Site | URL | What it tests | Login |
|---|------|-----|---------------|-------|
| 39 | The Internet | https://the-internet.herokuapp.com/ | about 40 classic traps: auth, upload, download, frames, dynamic loading | given |
| 40 | Expand Testing practice | https://practice.expandtesting.com/ | successor to The Internet, more pages | |
| 41 | DemoQA | https://demoqa.com/ | forms, widgets, interactions, Book Store | create (Book Store) |
| 42 | UI Testing Playground | http://uitestingplayground.com/ | AJAX delays, hidden layers, shifting buttons, non-breaking spaces | |
| 43 | WebdriverUniversity | https://webdriveruniversity.com/ | many small apps; popups, iframes, to-do list | |
| 44 | LetCode | https://letcode.in/test | inputs, drag and drop, tables, shadow DOM | |
| 45 | Test Pages (EvilTester) | https://testpages.eviltester.com/ | HTML forms, JS events, cookies, storage | |
| 46 | Selenium web form | https://www.selenium.dev/selenium/web/web-form.html | every input type on one page | |
| 47 | Formy | https://formy-project.herokuapp.com/ | autocomplete, modals, switching windows | |
| 48 | Rahul Shetty practice | https://rahulshettyacademy.com/AutomationPractice/ | new tab and new window, hover, iframes, tables | |
| 49 | QA Practice | https://qa-practice.razvanvancea.ro/ | forms, calendars, iframes, shopping cart | |
| 50 | Test Automation Practice blog | https://testautomationpractice.blogspot.com/ | Blogger page: pagination table, SVG, shadow DOM | |
| 51 | Ultimate QA | https://ultimateqa.com/automation | simple and complex page layouts | |
| 52 | GlobalSQA demo site | https://www.globalsqa.com/demo-site/ | jQuery UI widgets inside iframes | |
| 53 | Automation Bookstore | https://automationbookstore.dev/ | a list that filters as you type | |
| 54 | omayo | https://omayo.blogspot.com/ | odd controls, delayed buttons | |
| 55 | Tutorialspoint practice | https://www.tutorialspoint.com/selenium/practice/selenium_automation_practice.php | form, alerts, frames, links | |
| 56 | QAVBox demo | https://qavbox.github.io/demo/ | delays, alerts, drag and drop, sign-up form | |
| 57 | Practice Automation | https://practice-automation.com/ | popups, sliders, calendars, broken links | |
| 58 | LambdaTest Selenium Playground | https://www.lambdatest.com/selenium-playground/ | about 30 widgets, data tables, progress bars | |
| 59 | H Y R Tutorials | https://www.hyrtutorials.com/p/basic-controls.html | basic controls, windows, frames | |
| 60 | Try Testing This | https://trytestingthis.netlify.app/ | one dense page of mixed controls | |
| 61 | automationtesting.co.uk | https://www.automationtesting.co.uk/ | accordion, actions, hidden elements | |
| 62 | Leafground | https://www.leafground.com/ | PrimeFaces widgets, a hard markup style | |
| 63 | SeleniumBase demo page | https://seleniumbase.io/demo_page | every control on one page, plus an iframe | |
| 64 | SeleniumBase RealWorld | https://seleniumbase.io/realworld/login | login with a **TOTP / MFA** code | given |
| 65 | Techlistic practice form | https://www.techlistic.com/p/selenium-practice-form.html | a classic form, a table to read | |
| 66 | Basic Calculator | https://testsheepnz.github.io/BasicCalculator.html | builds you can choose to be buggy, checking results | |
| 67 | Quotes to Scrape | https://quotes.toscrape.com/ | login with any credentials, JS-rendered and delayed variants | given |
| 68 | Scrape This Site | https://www.scrapethissite.com/pages/ | AJAX, iframes, search forms | |
| 69 | httpbin form | https://httpbin.org/forms/post | submitting a form and checking the echoed result | |
| 70 | DummyTicket | https://www.dummyticket.com/dummy-ticket-for-visa-application/ | long real-world form, date pickers (stop before payment) | |
| 71 | W3Schools Tryit | https://www.w3schools.com/html/tryit.asp?filename=tryhtml_basic | code editor plus a result iframe | |
| 72 | jQuery UI demos | https://jqueryui.com/demos/ | drag, sort, resize, datepicker, all in iframes | |

## D. Component libraries and rich widgets

| # | Site | URL | What it tests | Login |
|---|------|-----|---------------|-------|
| 73 | MUI | https://mui.com/material-ui/all-components/ | portalled menus, autocomplete, pickers | |
| 74 | Ant Design | https://ant.design/components/overview | cascader, date ranges, transfer, tree select | |
| 75 | React Select | https://react-select.com/home | async, multi and creatable selects | |
| 76 | AG Grid | https://www.ag-grid.com/example/ | virtualised grid, sorting, filters, editing cells | |
| 77 | Handsontable | https://handsontable.com/demo | spreadsheet editing, keyboard navigation | |
| 78 | Kendo UI demos | https://demos.telerik.com/kendo-ui/ | enterprise grids, schedulers, charts | |
| 79 | TodoMVC (React) | https://todomvc.com/examples/react/dist/ | add, edit, toggle, filter, double-click to edit | |
| 80 | Playwright TodoMVC | https://demo.playwright.dev/todomvc/ | the same app, as a baseline | |
| 81 | Swagger Petstore | https://petstore.swagger.io/ | expanding an API console, "Try it out", reading the JSON | |
| 82 | ReqRes | https://reqres.in/ | API demo page, reading the response | |

## E. Canvas, visual and computer mode

| # | Site | URL | What it tests | Login |
|---|------|-----|---------------|-------|
| 83 | Excalidraw | https://excalidraw.com/ | drawing on canvas, shapes, text | |
| 84 | tldraw | https://www.tldraw.com/ | canvas, dragging, selection | |
| 85 | diagrams.net | https://app.diagrams.net/ | dragging from a palette, connectors, menus | |
| 86 | Photopea | https://www.photopea.com/ | canvas image editor, desktop-style menus | |
| 87 | 2048 | https://play2048.co/ | keyboard input, reading a changing board | |
| 88 | Monkeytype | https://monkeytype.com/ | fast typing, reading results | |
| 89 | Lichess | https://www.lichess.org/ | play the computer, drag pieces | optional |
| 90 | PDF.js viewer | https://mozilla.github.io/pdf.js/web/viewer.html | PDF navigation, search, zoom | |

## F. Real public sites: read-only search, navigation and extraction

| # | Site | URL | What it tests | Login |
|---|------|-----|---------------|-------|
| 91 | Wikipedia | https://en.wikipedia.org/ | search, infobox extraction, following links | |
| 92 | OpenStreetMap | https://www.openstreetmap.org/ | search, directions, map UI | |
| 93 | Hacker News | https://news.ycombinator.com/ | paging, reading rankings and comment trees | |
| 94 | Project Gutenberg | https://www.gutenberg.org/ | search, download an EPUB or TXT | |
| 95 | Internet Archive | https://archive.org/ | search, Wayback Machine calendar | |
| 96 | MDN | https://developer.mozilla.org/ | search overlay, reading docs | |
| 97 | GOV.UK holiday calculator | https://www.gov.uk/calculate-your-holiday-entitlement | multi-step "smart answer" wizard | |
| 98 | Calculator.net | https://www.calculator.net/ | mortgage and BMI forms, ad-heavy pages | |
| 99 | Worldometers | https://www.worldometers.info/ | live-updating numbers, large tables | |
| 100 | Met Office | https://www.metoffice.gov.uk/ | location search, forecast tabs, cookie banner | |

Helper, not a test target: **Mailinator** (https://www.mailinator.com/) public
inboxes, for the signups that send a verification email (Guru99 in
particular).

## Logins to create

Sign up on these **19**, with one dedicated test identity: a throwaway email
address (a plus-address or a Mailinator inbox), a made-up name, and a
password used nowhere else. Never give these sites real personal data.

| # | Site | Notes |
|---|------|-------|
| 2 | Automation Exercise | |
| 3 | Tricentis Demo Web Shop | |
| 4 | Automation Test Store | |
| 5 | TutorialsNinja | |
| 6 | Demoblaze | |
| 7 | LambdaTest eCommerce Playground | |
| 9 | Rahul Shetty client store | |
| 11 | JPetStore | |
| 19 | ParaBank | its database resets now and then; a test should be able to register again |
| 21 | Guru99 Bank | you enter an email and it sends the credentials, which expire after about 20 days |
| 27 | Contact List App | |
| 28 | Expand Testing Notes | |
| 29 | Buggy Cars Rating | |
| 30 | Conduit (Bondar) | |
| 31 | Conduit (RealWorld) | |
| 33 | Gitea demo | the demo instance may wipe data; keep your repos disposable |
| 36 | Open Library | real nonprofit site; keep the test gentle |
| 41 | DemoQA Book Store | |
| 89 | Lichess | optional; you can play the computer without an account |

All of these are shared public demos, so other people's data shows up and
changes. A test should create the data it checks rather than expect it to be
there already.

Keep credentials in the survey project's gitignored `.env`, not in the `.md`
files (see "No real secrets in tracked files" in CLAUDE.md).

**No accounts on big commercial sites** (Amazon, eBay, Booking, LinkedIn,
Google, Reddit and so on): their terms forbid automation, they block bots
(several returned 403 or 202 to a plain request), and a CAPTCHA or 2FA
challenge would make a run fail for reasons unrelated to Steptix.

## Feedback rubric

Score every run on the same scale so the 100 results can be added up.

| Field | Values |
|-------|--------|
| Outcome | pass first try / pass after editing the steps / blocked |
| AI steps vs compiled | how many steps needed AI on replay after a compile |
| Retries | the number of retries or self-heals during the run |
| Time | wall clock, and the slowest step |
| Failure category | locator · timing/waiting · iframe · shadow DOM · new tab or window · canvas · upload/download · auth/MFA · popup or cookie banner · data extraction · assertion wording · site flakiness |
| Step rewording | did a step have to be reworded before Steptix understood it? Paste the before and after |
| Framework gap | one line: what Steptix should do so this works with no workaround |

Group the results by failure category at the end. The categories with the
most failures are where framework work will pay off most.
