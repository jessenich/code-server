/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Event } from 'vs/base/common/event';
import { Disposable, DisposableStore, IDisposable, toDisposable } from 'vs/base/common/lifecycle';
import { FileAccess, Schemas } from 'vs/base/common/network';
import { URI } from 'vs/base/common/uri';
import { INativeEnvironmentService } from 'vs/platform/environment/common/environment';
import { session } from 'electron';
import { ILogService } from 'vs/platform/log/common/log';
import { TernarySearchTree } from 'vs/base/common/map';
import { isLinux, isPreferringBrowserCodeLoad } from 'vs/base/common/platform';
import { IWindowsMainService } from 'vs/platform/windows/electron-main/windows';
import { extname } from 'vs/base/common/resources';

type ProtocolCallback = { (result: string | Electron.FilePathWithHeaders | { error: number }): void };

export class FileProtocolHandler extends Disposable {

	private readonly validRoots = TernarySearchTree.forUris<boolean>(() => !isLinux);
	private readonly validExtensions = new Set(['.png', '.jpg', '.jpeg', '.gif', '.bmp']); // https://github.com/microsoft/vscode/issues/119384

	constructor(
		@INativeEnvironmentService environmentService: INativeEnvironmentService,
		@ILogService private readonly logService: ILogService
	) {
		super();

		const { defaultSession } = session;

		// Define an initial set of roots we allow loading from
		// - appRoot	: all files installed as part of the app
		// - extensions : all files shipped from extensions
		// - storage    : all files in global and workspace storage (https://github.com/microsoft/vscode/issues/116735)
		this.validRoots.set(URI.file(environmentService.appRoot), true);
		this.validRoots.set(URI.file(environmentService.extensionsPath), true);
		this.validRoots.set(environmentService.globalStorageHome, true);
		this.validRoots.set(environmentService.workspaceStorageHome, true);

		// Register vscode-file:// handler
		defaultSession.protocol.registerFileProtocol(Schemas.vscodeFileResource, (request, callback) => this.handleResourceRequest(request, callback as unknown as ProtocolCallback));

		// Intercept any file:// access
		defaultSession.protocol.interceptFileProtocol(Schemas.file, (request, callback) => this.handleFileRequest(request, callback as unknown as ProtocolCallback));

		// Cleanup
		this._register(toDisposable(() => {
			defaultSession.protocol.unregisterProtocol(Schemas.vscodeFileResource);
			defaultSession.protocol.uninterceptProtocol(Schemas.file);
		}));
	}

	injectWindowsMainService(windowsMainService: IWindowsMainService): void {
		this._register(windowsMainService.onDidSignalReadyWindow(window => {
			if (window.config?.extensionDevelopmentPath || window.config?.extensionTestsPath) {
				const disposables = new DisposableStore();
				disposables.add(Event.any(window.onDidClose, window.onDidDestroy)(() => disposables.dispose()));

				// Allow access to extension development path
				if (window.config.extensionDevelopmentPath) {
					for (const extensionDevelopmentPath of window.config.extensionDevelopmentPath) {
						disposables.add(this.addValidRoot(URI.file(extensionDevelopmentPath)));
					}
				}

				// Allow access to extension tests path
				if (window.config.extensionTestsPath) {
					disposables.add(this.addValidRoot(URI.file(window.config.extensionTestsPath)));
				}
			}
		}));
	}

	private addValidRoot(root: URI): IDisposable {
		if (!this.validRoots.get(root)) {
			this.validRoots.set(root, true);

			return toDisposable(() => this.validRoots.delete(root));
		}

		return Disposable.None;
	}

	private async handleFileRequest(request: Electron.ProtocolRequest, callback: ProtocolCallback) {
		const fileUri = URI.parse(request.url);

		// isPreferringBrowserCodeLoad: false
		if (!isPreferringBrowserCodeLoad) {

			// first check by validRoots
			if (this.validRoots.findSubstr(fileUri)) {
				return callback({
					path: fileUri.fsPath
				});
			}

			// then check by validExtensions
			if (this.validExtensions.has(extname(fileUri))) {
				return callback({
					path: fileUri.fsPath
				});
			}

			// finally block to load the resource
			this.logService.error(`${Schemas.file}: Refused to load resource ${fileUri.fsPath} from ${Schemas.file}: protocol (original URL: ${request.url})`);

			return callback({ error: -3 /* ABORTED */ });
		}

		// isPreferringBrowserCodeLoad: true
		// => block any file request
		else {
			this.logService.error(`Refused to load resource ${fileUri.fsPath} from ${Schemas.file}: protocol (original URL: ${request.url})`);

			return callback({ error: -3 /* ABORTED */ });
		}
	}

	private async handleResourceRequest(request: Electron.ProtocolRequest, callback: ProtocolCallback) {
		const uri = URI.parse(request.url);

		// Restore the `vscode-file` URI to a `file` URI so that we can
		// ensure the root is valid and properly tell Chrome where the
		// resource is at.
		const fileUri = FileAccess.asFileUri(uri);

		// first check by validRoots
		if (this.validRoots.findSubstr(fileUri)) {
			return callback({
				path: fileUri.fsPath
			});
		}

		// then check by validExtensions
		if (this.validExtensions.has(extname(fileUri))) {
			return callback({
				path: fileUri.fsPath
			});
		}

		// finally block to load the resource
		this.logService.error(`${Schemas.vscodeFileResource}: Refused to load resource ${fileUri.fsPath} from ${Schemas.vscodeFileResource}: protocol (original URL: ${request.url})`);

		return callback({ error: -3 /* ABORTED */ });
	}
}
