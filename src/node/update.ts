import * as cp from "child_process";
import * as os from "os";
import * as path from "path";
import { Stream } from "stream";
import * as util from "util";
import { toVSBufferReadableStream } from "vs/base/common/buffer";
import { CancellationToken } from "vs/base/common/cancellation";
import { URI } from "vs/base/common/uri";
import * as pfs from "vs/base/node/pfs";
import { IConfigurationService } from "vs/platform/configuration/common/configuration";
import { IEnvironmentService } from "vs/platform/environment/common/environment";
import { IFileService } from "vs/platform/files/common/files";
import { ILogService } from "vs/platform/log/common/log";
import pkg from "vs/platform/product/node/package";
import { asJson, IRequestService } from "vs/platform/request/common/request";
import { AvailableForDownload, State, StateType, UpdateType } from "vs/platform/update/common/update";
import { AbstractUpdateService } from "vs/platform/update/electron-main/abstractUpdateService";
import { ipcMain } from "vs/server/src/node/ipc";
import { extract } from "vs/server/src/node/marketplace";
import { tmpdir } from "vs/server/src/node/util";
import * as zlib from "zlib";

interface IUpdate {
	name: string;
}

export class UpdateService extends AbstractUpdateService {
	_serviceBrand: any;

	constructor(
		@IConfigurationService configurationService: IConfigurationService,
		@IEnvironmentService environmentService: IEnvironmentService,
		@IRequestService requestService: IRequestService,
		@ILogService logService: ILogService,
		@IFileService private readonly fileService: IFileService,
	) {
		super(null, configurationService, environmentService, requestService, logService);
	}

	public async isLatestVersion(latest?: IUpdate | null): Promise<boolean | undefined> {
		if (!latest) {
			latest = await this.getLatestVersion();
		}
		if (latest) {
			const latestMajor = parseInt(latest.name);
			const currentMajor = parseInt(pkg.codeServerVersion);
			return !isNaN(latestMajor) && !isNaN(currentMajor) &&
				currentMajor <= latestMajor && latest.name === pkg.codeServerVersion;
		}
		return true;
	}

	protected buildUpdateFeedUrl(): string {
		return "https://api.github.com/repos/cdr/code-server/releases/latest";
	}

	protected doQuitAndInstall(): void {
		ipcMain.relaunch();
	}

	protected async doCheckForUpdates(context: any): Promise<void> {
		if (this.state.type !== StateType.Idle) {
			return Promise.resolve();
		}
		this.setState(State.CheckingForUpdates(context));
		try {
			const update = await this.getLatestVersion();
			if (!update || this.isLatestVersion(update)) {
				this.setState(State.Idle(UpdateType.Archive));
			} else {
				this.setState(State.AvailableForDownload({
					version: update.name,
					productVersion: update.name,
				}));
			}
		} catch (error) {
			this.onRequestError(error, !!context);
		}
	}

	private async getLatestVersion(): Promise<IUpdate | null> {
		const data = await this.requestService.request({
			url: this.url,
			headers: {
				"User-Agent": "code-server",
			},
		}, CancellationToken.None);
		return asJson(data);
	}

	protected async doDownloadUpdate(state: AvailableForDownload): Promise<void> {
		this.setState(State.Updating(state.update));
		const target = os.platform();
		const releaseName = await this.buildReleaseName(state.update.version);
		const url = "https://github.com/cdr/code-server/releases/download/"
			+ `${state.update.version}/${releaseName}`
			+ `.${target === "darwin" ? "zip" : "tar.gz"}`;
		const downloadPath = path.join(tmpdir, `${state.update.version}-archive`);
		const extractPath = path.join(tmpdir, state.update.version);
		try {
			await pfs.mkdirp(tmpdir);
			const context = await this.requestService.request({ url }, CancellationToken.None);
			// Decompress the gzip as we download. If the gzip encoding is set then
			// the request service already does this.
			// HACK: This uses knowledge of the internals of the request service.
			if (target !== "darwin" && context.res.headers["content-encoding"] !== "gzip") {
				const stream = (context.res as any as Stream);
				stream.removeAllListeners();
				context.stream = toVSBufferReadableStream(stream.pipe(zlib.createGunzip()));
			}
			await this.fileService.writeFile(URI.file(downloadPath), context.stream);
			await extract(downloadPath, extractPath, undefined, CancellationToken.None);
			const newBinary = path.join(extractPath, releaseName, "code-server");
			if (!pfs.exists(newBinary)) {
				throw new Error("No code-server binary in extracted archive");
			}
			await pfs.unlink(process.argv[0]); // Must unlink first to avoid ETXTBSY.
			await pfs.move(newBinary, process.argv[0]);
			this.setState(State.Ready(state.update));
		} catch (error) {
			this.onRequestError(error, true);
		}
		await Promise.all([downloadPath, extractPath].map((p) => pfs.rimraf(p)));
	}

	private onRequestError(error: Error, showNotification?: boolean): void {
		this.logService.error(error);
		const message: string | undefined = showNotification ? (error.message || error.toString()) : undefined;
		this.setState(State.Idle(UpdateType.Archive, message));
	}

	private async buildReleaseName(release: string): Promise<string> {
		let target: string = os.platform();
		if (target === "linux") {
			const result = await util.promisify(cp.exec)("ldd --version").catch((error) => ({
				stderr: error.message,
				stdout: "",
			}));
			if (result.stderr.indexOf("musl") !== -1 || result.stdout.indexOf("musl") !== -1) {
				target = "alpine";
			}
		}
		let arch = os.arch();
		if (arch === "x64") {
			arch = "x86_64";
		}
		return `code-server${release}-${target}-${arch}`;
	}
}
