---
tags: [survey, section-c, calculator, data-driven, buggy-builds]
timeout: 600s
---

# 66 Basic Calculator: the same checks on several builds

TestSheepNZ's calculator has a Build dropdown. "Prototype" works, and builds
1 to 9 each have a different bug. The test runs the same arithmetic on three
builds, so a correct run passes on the prototype and fails on the buggy builds
for the right reason.

Rows 2 and 3 are **expected to fail**. What to record is whether the failure
names the wrong answer, or something else, such as a locator or timing problem.

**Probes:** a row-per-case table, a select that changes behaviour, reading an
output field, an "Integers only" checkbox, Concatenate as a non-arithmetic
operation.

## Config
- baseUrl: https://testsheepnz.github.io/BasicCalculator.html

## Steps
1. Calculate on a build

### Calculate on a build
| build     |
|-----------|
| Prototype |
| 1         |
| 2         |
1. Navigate to the baseUrl
2. Select "{{build}}" in the Build dropdown
3. Enter 2 as the first number and 3 as the second, choose Add and click Calculate
4. Verify the answer is 5
5. Choose Concatenate and click Calculate
6. Verify the answer is 23
7. Enter 10 as the first number and 4 as the second, choose Divide, tick "Integers only" and click Calculate
8. Verify the answer is 2
9. Click Clear
10. Verify the answer field is empty
