---
tags: [survey, section-c, jquery-ui, iframes, drag-drop, sortable, resizable, datepicker, slider]
timeout: 600s
---

# 72 jQuery UI demos: interactions inside iframes

jQuery UI's official demos, each running in an iframe on its own page. These
are the original versions of the widgets that half the practice sites copy.

**Probes:** drag onto a droppable, reordering a sortable list, resizing by a
handle, lasso-selecting several items, picking a date, a slider, an
autocomplete. Every one of them sits inside an iframe.

## Config
- baseUrl: https://jqueryui.com/

## Steps
1. Navigate to droppable/
2. Drag the "Drag me to my target" box onto the "Drop here" box
3. Verify the target says "Dropped!"
4. Navigate to sortable/
5. Drag "Item 1" below "Item 3"
6. Read the order of the items [as: sorted_items]
7. Verify that "Item 1" comes after "Item 3" in {{sorted_items}}
8. Navigate to resizable/
9. Drag the bottom-right corner of the "Resizable" box to make it about twice as wide
10. Verify the box is wider than it was
11. Navigate to selectable/
12. Select items 2, 3 and 4 by dragging across them
13. Verify items 2, 3 and 4 are highlighted as selected
14. Navigate to datepicker/
15. Open the date picker and pick the 15th of the month shown
16. Verify the date field holds a date on the 15th
17. Navigate to autocomplete/
18. Type "ja" into the tags field and choose "JavaScript" from the suggestions
19. Verify the tags field contains "JavaScript"
