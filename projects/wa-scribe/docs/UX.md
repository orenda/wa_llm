# Chat selection and Google connection

The intended normal flow is: install, connect Google Drive, check chats in a list, and click Sync. Requiring users to open every conversation or configure their own OAuth app is an alpha limitation, not the intended product experience.

## Implemented UI simplification

The 0.1.4 panel shows added-chat checkboxes, concise results, Open export and Sync/Stop. IDs, detailed status, archived links and recovery/deletion controls remain available under each chat's More actions. Sync settings and Drive setup/diagnostics are expandable. Configured builds hide the manual configuration action; connected builds move Reconnect into diagnostics. Text-only capability is stated explicitly.

This changes presentation only. Existing identity bindings, source collection, selected-chat state, recovery journal and destination behavior are unchanged. It does not discover WhatsApp's complete chat list or navigate between conversations.

## Chat-list and collection work still needed

The current collector reads bodies from the selected conversation's DOM. Other conversations' messages are not rendered there. The existing native database access reads message keys only; it is not a cached-message or attachment reader.

Discovery must obtain stable account/chat IDs and display labels. Names can label rows but cannot bind exports. The observed chat database key path establishes IDs, not the still-unverified record fields needed for names. Discovery must describe its actual scope, including filters, archived chats and traversal limits.

One possible collection path is to switch between checked chats through WhatsApp's normal UI, verify account/chat/message identity after each transition, then collect. Selection itself should not navigate or export. Sync must stop on user navigation, account change or an identity mismatch. Opening conversations can mark messages read; the owner's navigation preference is pending. The extension should not navigate until that preference is resolved and the adapter has an evidenced identity path.

Reading cached message records instead would require a separately implemented and validated adapter. It would still be limited to cached content and would not establish complete history or available original attachments.

## Google setup belongs to the app

Chrome's existing Google sign-in supplies the user's identity. The extension's registered OAuth client identifies which application requests Drive permission. The app owner enables Drive API, configures the consent audience and creates a Chrome-extension OAuth client tied to the stable extension ID. These are one-time app configuration, not per-user installation steps.

A configured package includes the public client ID and uses the existing Connect action and Chrome token cache with only `drive.file`. No client secret, password, refresh token or new login system is needed. The current generic package lacks that public client ID; the installed owner configuration is not accessible from this cloud workspace. Providing the public ID allows a preconfigured release. Unpacked development does not itself require a Web Store listing. Wider distribution also needs an appropriate Google consent audience.
