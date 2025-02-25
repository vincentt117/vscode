/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { localize } from 'vs/nls';
import { Action } from 'vs/base/common/actions';
import { IDisposable, toDisposable, combinedDisposable } from 'vs/base/common/lifecycle';
import { URI } from 'vs/base/common/uri';
import { IDialogService } from 'vs/platform/dialogs/common/dialogs';
import { IExtensionGalleryService, IExtensionIdentifier, IExtensionManagementService } from 'vs/platform/extensionManagement/common/extensionManagement';
import { IExtensionEnablementService, EnablementState } from 'vs/workbench/services/extensionManagement/common/extensionManagement';
import { areSameExtensions } from 'vs/platform/extensionManagement/common/extensionManagementUtil';
import { createDecorator } from 'vs/platform/instantiation/common/instantiation';
import { INotificationHandle, INotificationService, Severity } from 'vs/platform/notification/common/notification';
import { IStorageService, StorageScope } from 'vs/platform/storage/common/storage';
import { IURLHandler, IURLService } from 'vs/platform/url/common/url';
import { IWindowService } from 'vs/platform/windows/common/windows';
import { IExtensionService } from 'vs/workbench/services/extensions/common/extensions';
import { ExtensionIdentifier } from 'vs/platform/extensions/common/extensions';
import { registerSingleton } from 'vs/platform/instantiation/common/extensions';

const FIVE_MINUTES = 5 * 60 * 1000;
const THIRTY_SECONDS = 30 * 1000;
const URL_TO_HANDLE = 'extensionUrlHandler.urlToHandle';

function isExtensionId(value: string): boolean {
	return /^[a-z0-9][a-z0-9\-]*\.[a-z0-9][a-z0-9\-]*$/i.test(value);
}

export const IExtensionUrlHandler = createDecorator<IExtensionUrlHandler>('inactiveExtensionUrlHandler');

export interface IExtensionUrlHandler {
	readonly _serviceBrand: any;
	registerExtensionHandler(extensionId: ExtensionIdentifier, handler: IURLHandler): void;
	unregisterExtensionHandler(extensionId: ExtensionIdentifier): void;
}

/**
 * This class handles URLs which are directed towards inactive extensions.
 * If a URL is directed towards an inactive extension, it buffers it,
 * activates the extension and re-opens the URL once the extension registers
 * a URL handler. If the extension never registers a URL handler, the urls
 * will eventually be garbage collected.
 *
 * It also makes sure the user confirms opening URLs directed towards extensions.
 */
export class ExtensionUrlHandler implements IExtensionUrlHandler, IURLHandler {

	readonly _serviceBrand: any;

	private extensionHandlers = new Map<string, IURLHandler>();
	private uriBuffer = new Map<string, { timestamp: number, uri: URI }[]>();
	private disposable: IDisposable;

	constructor(
		@IURLService urlService: IURLService,
		@IExtensionService private readonly extensionService: IExtensionService,
		@IDialogService private readonly dialogService: IDialogService,
		@INotificationService private readonly notificationService: INotificationService,
		@IExtensionManagementService private readonly extensionManagementService: IExtensionManagementService,
		@IExtensionEnablementService private readonly extensionEnablementService: IExtensionEnablementService,
		@IWindowService private readonly windowService: IWindowService,
		@IExtensionGalleryService private readonly galleryService: IExtensionGalleryService,
		@IStorageService private readonly storageService: IStorageService
	) {
		const interval = setInterval(() => this.garbageCollect(), THIRTY_SECONDS);
		const urlToHandleValue = this.storageService.get(URL_TO_HANDLE, StorageScope.WORKSPACE);
		if (urlToHandleValue) {
			this.storageService.remove(URL_TO_HANDLE, StorageScope.WORKSPACE);
			this.handleURL(URI.revive(JSON.parse(urlToHandleValue)), true);
		}

		this.disposable = combinedDisposable(
			urlService.registerHandler(this),
			toDisposable(() => clearInterval(interval))
		);
	}

	async handleURL(uri: URI, confirmed?: boolean): Promise<boolean> {
		if (!isExtensionId(uri.authority)) {
			return false;
		}

		const extensionId = uri.authority;
		const wasHandlerAvailable = this.extensionHandlers.has(ExtensionIdentifier.toKey(extensionId));
		const extension = await this.extensionService.getExtension(extensionId);

		if (!extension) {
			await this.handleUnhandledURL(uri, { id: extensionId });
			return true;
		}

		if (!confirmed) {
			let uriString = uri.toString();

			if (uriString.length > 40) {
				uriString = `${uriString.substring(0, 30)}...${uriString.substring(uriString.length - 5)}`;
			}

			const result = await this.dialogService.confirm({
				message: localize('confirmUrl', "Allow an extension to open this URL?", extensionId),
				detail: `${extension.displayName || extension.name} (${extensionId}) wants to open a URL:\n\n${uriString}`,
				primaryButton: localize('open', "&&Open"),
				type: 'question'
			});

			if (!result.confirmed) {
				return true;
			}
		}

		const handler = this.extensionHandlers.get(ExtensionIdentifier.toKey(extensionId));

		if (handler) {
			if (!wasHandlerAvailable) {
				// forward it directly
				return await handler.handleURL(uri);
			}

			// let the ExtensionUrlHandler instance handle this
			return false;
		}

		// collect URI for eventual extension activation
		const timestamp = new Date().getTime();
		let uris = this.uriBuffer.get(ExtensionIdentifier.toKey(extensionId));

		if (!uris) {
			uris = [];
			this.uriBuffer.set(ExtensionIdentifier.toKey(extensionId), uris);
		}

		uris.push({ timestamp, uri });

		// activate the extension
		await this.extensionService.activateByEvent(`onUri:${ExtensionIdentifier.toKey(extensionId)}`);
		return true;
	}

	registerExtensionHandler(extensionId: ExtensionIdentifier, handler: IURLHandler): void {
		this.extensionHandlers.set(ExtensionIdentifier.toKey(extensionId), handler);

		const uris = this.uriBuffer.get(ExtensionIdentifier.toKey(extensionId)) || [];

		for (const { uri } of uris) {
			handler.handleURL(uri);
		}

		this.uriBuffer.delete(ExtensionIdentifier.toKey(extensionId));
	}

	unregisterExtensionHandler(extensionId: ExtensionIdentifier): void {
		this.extensionHandlers.delete(ExtensionIdentifier.toKey(extensionId));
	}

	private async handleUnhandledURL(uri: URI, extensionIdentifier: IExtensionIdentifier): Promise<void> {
		const installedExtensions = await this.extensionManagementService.getInstalled();
		const extension = installedExtensions.filter(e => areSameExtensions(e.identifier, extensionIdentifier))[0];

		// Extension is installed
		if (extension) {
			const enabled = this.extensionEnablementService.isEnabled(extension);

			// Extension is not running. Reload the window to handle.
			if (enabled) {
				const result = await this.dialogService.confirm({
					message: localize('reloadAndHandle', "Extension '{0}' is not loaded. Would you like to reload the window to load the extension and open the URL?", extension.manifest.displayName || extension.manifest.name),
					detail: `${extension.manifest.displayName || extension.manifest.name} (${extensionIdentifier.id}) wants to open a URL:\n\n${uri.toString()}`,
					primaryButton: localize('reloadAndOpen', "&&Reload Window and Open"),
					type: 'question'
				});

				if (!result.confirmed) {
					return;
				}

				await this.reloadAndHandle(uri);
			}

			// Extension is disabled. Enable the extension and reload the window to handle.
			else {
				const result = await this.dialogService.confirm({
					message: localize('enableAndHandle', "Extension '{0}' is disabled. Would you like to enable the extension and reload the window to open the URL?", extension.manifest.displayName || extension.manifest.name),
					detail: `${extension.manifest.displayName || extension.manifest.name} (${extensionIdentifier.id}) wants to open a URL:\n\n${uri.toString()}`,
					primaryButton: localize('enableAndReload', "&&Enable and Open"),
					type: 'question'
				});

				if (!result.confirmed) {
					return;
				}

				await this.extensionEnablementService.setEnablement([extension], EnablementState.Enabled);
				await this.reloadAndHandle(uri);
			}
		}

		// Extension is not installed
		else {
			const galleryExtension = await this.galleryService.getCompatibleExtension(extensionIdentifier);

			if (!galleryExtension) {
				return;
			}

			// Install the Extension and reload the window to handle.
			const result = await this.dialogService.confirm({
				message: localize('installAndHandle', "Extension '{0}' is not installed. Would you like to install the extension and reload the window to open this URL?", galleryExtension.displayName || galleryExtension.name),
				detail: `${galleryExtension.displayName || galleryExtension.name} (${extensionIdentifier.id}) wants to open a URL:\n\n${uri.toString()}`,
				primaryButton: localize('install', "&&Install"),
				type: 'question'
			});

			if (!result.confirmed) {
				return;
			}

			let notificationHandle: INotificationHandle | null = this.notificationService.notify({ severity: Severity.Info, message: localize('Installing', "Installing Extension '{0}'...", galleryExtension.displayName || galleryExtension.name) });
			notificationHandle.progress.infinite();
			notificationHandle.onDidClose(() => notificationHandle = null);

			try {
				await this.extensionManagementService.installFromGallery(galleryExtension);
				const reloadMessage = localize('reload', "Would you like to reload the window and open the URL '{0}'?", uri.toString());
				const reloadActionLabel = localize('Reload', "Reload Window and Open");

				if (notificationHandle) {
					notificationHandle.progress.done();
					notificationHandle.updateMessage(reloadMessage);
					notificationHandle.updateActions({
						primary: [new Action('reloadWindow', reloadActionLabel, undefined, true, () => this.reloadAndHandle(uri))]
					});
				} else {
					this.notificationService.prompt(Severity.Info, reloadMessage, [{ label: reloadActionLabel, run: () => this.reloadAndHandle(uri) }], { sticky: true });
				}
			} catch (e) {
				if (notificationHandle) {
					notificationHandle.progress.done();
					notificationHandle.updateSeverity(Severity.Error);
					notificationHandle.updateMessage(e);
				} else {
					this.notificationService.error(e);
				}
			}
		}
	}

	private async reloadAndHandle(url: URI): Promise<void> {
		this.storageService.store(URL_TO_HANDLE, JSON.stringify(url.toJSON()), StorageScope.WORKSPACE);
		await this.windowService.reloadWindow();
	}

	// forget about all uris buffered more than 5 minutes ago
	private garbageCollect(): void {
		const now = new Date().getTime();
		const uriBuffer = new Map<string, { timestamp: number, uri: URI }[]>();

		this.uriBuffer.forEach((uris, extensionId) => {
			uris = uris.filter(({ timestamp }) => now - timestamp < FIVE_MINUTES);

			if (uris.length > 0) {
				uriBuffer.set(extensionId, uris);
			}
		});

		this.uriBuffer = uriBuffer;
	}

	dispose(): void {
		this.disposable.dispose();
		this.extensionHandlers.clear();
		this.uriBuffer.clear();
	}
}

registerSingleton(IExtensionUrlHandler, ExtensionUrlHandler);
