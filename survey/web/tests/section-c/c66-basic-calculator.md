---
tags: [survey, section-c, calculator, data-driven, buggy-builds]
timeout: 600s
---

# 66 Basic Calculator: the same checks on several builds

TestSheepNZ's calculator has a Build dropdown. "Prototype" works, and builds
1 to 9 each have a different bug. The test checks Add on three builds, and each
row says the answer that build gives. So build 2's bug — it concatenates when
asked to add, answering 23 for 2 + 3 — is the expected answer on its row, and a
pass means Steptix read the bug correctly rather than missing it.

The first version expected 5 from every build and called build 2's failure
"expected". A file has no way to say a row is meant to fail, so the bug is
written down as the answer instead.

**Probes:** a row-per-case table, a select that changes behaviour, reading an
output field, an "Integers only" checkbox, Concatenate as a non-arithmetic
operation.

## Config
- baseUrl: https://testsheepnz.github.io/BasicCalculator.html

## Steps
1. Navigate to the baseUrl
2. Select "Prototype" in the Build dropdown
3. Enter 2 as the first number and 3 as the second, choose Concatenate and click Calculate
4. Verify the answer is 23
5. Enter 10 as the first number and 4 as the second, choose Divide, tick "Integers only" and click Calculate
6. Verify the answer is 2
7. Click Clear
8. Verify the answer field is empty
9. Add on a build

### Add on a build
| build     | answer |
|-----------|--------|
| Prototype | 5      |
| 1         | 5      |
| 2         | 23     |
1. Navigate to the baseUrl
2. Select "{{build}}" in the Build dropdown
3. Enter 2 as the first number and 3 as the second, choose Add and click Calculate
4. Verify the answer is {{answer}}
