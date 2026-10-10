import { test } from "../support/fixtures";
import { clickNewChat } from "../support/helpers/launcher";
import {
  attachImageFromMenu,
  expectAttachmentPill,
  expectComposerVisible,
} from "../support/helpers/composer";

const MINIMAL_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  "base64",
);

const TEST_IMAGE = { name: "test.png", mimeType: "image/png", buffer: MINIMAL_PNG };

test.describe("Composer image picker", () => {
  // Mobile browsers only open a file chooser for a trusted user activation:
  // a click dispatched through element.dispatchEvent() is untrusted and ignored,
  // while element.click() inside the gesture opens it. Desktop Chromium is more
  // permissive, so model that rule here to catch the regression on desktop too.
  test("Add image opens the file chooser from a trusted gesture", async ({
    page,
    withWorkspace,
  }) => {
    test.setTimeout(60_000);
    await page.addInitScript(() => {
      const dispatchEvent = HTMLInputElement.prototype.dispatchEvent;
      HTMLInputElement.prototype.dispatchEvent = function (this: HTMLInputElement, event: Event) {
        if (this.type === "file" && event.type === "click") {
          // Mobile browser rule: untrusted activation of a file input is inert.
          return true;
        }
        return dispatchEvent.call(this, event);
      };
    });

    const workspace = await withWorkspace({ prefix: "attach-image-picker-" });
    await workspace.navigateTo();
    await clickNewChat(page);
    await expectComposerVisible(page);

    // Waits for the real "filechooser" event, then sets a synthetic PNG.
    await attachImageFromMenu(page, TEST_IMAGE);
    await expectAttachmentPill(page, "composer-image-attachment-pill");
  });
});
