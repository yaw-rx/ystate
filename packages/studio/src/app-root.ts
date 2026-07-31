import { Component, Inject, RxElement } from '@yaw-rx/core';
import '@yaw-rx/core/router/outlet';
import { WorkspaceEvaluationService } from './app-root/services/workspace-evaluation.service.js';
import { RuntimeFilesystemService } from './app-root/services/runtime-filesystem.service.js';
import { SandboxService } from './app-root/services/sandbox.service.js';
import { TypeAnalysisService } from './app-root/services/type-analysis.service.js';
import { LiveModulesService } from './app-root/services/live-modules.service.js';
import { FormAnalysisService } from './app-root/services/form-analysis.service.js';
import { FormRunService } from './app-root/services/form-run.service.js';
import { FILESYSTEM_STORAGE } from './app-root/services/filesystem-storage.js';
// import { LocalStorageFilesystemStorage } from './app-root/services/filesystem-storage/local-storage.js';
import { NullFilesystemStorage } from './app-root/services/filesystem-storage/null-storage.js';
import './app-root/components/side-bar.component.js';

/*
For the form concept its not going to be one file it will be some html some css and some js
 i think effectively it will define a yaw component dynamically one which will get a tag name with some
 entropy

 so its not really a normal html file its like those online html fragment editors which give you a 3 vertically
 split components.

perhaps code panel needs a mode for this view or even we make a new one... moreover the graph closure stuff still
needs to be ever present and im not sure this was done properly

it should be

<code-panel rx-if(ts file)>
<form-panel rx-if(a form)>

<bottom closure terminal output>
 maybe like this or perhaps will we need other terminal diagnositics for the form probably yes.

 ... what about our drag drop functionality we need to be able to drag export from the LHS into any file...
 hmmm things to think about

 forms need to be able to import from sibling .ts files (behavior subjects etc) so they can be wired to
 buttons/graphs - not supported yet, pure .html files aren't supported either. See docs/filesystem-runtime.md.
*/

@Component({
    selector: 'app-root',
    providers: [
        SandboxService,
        TypeAnalysisService,
        FormAnalysisService,
        WorkspaceEvaluationService,
        LiveModulesService,
        // { provide: FILESYSTEM_STORAGE, useClass: LocalStorageFilesystemStorage },
        { provide: FILESYSTEM_STORAGE, useClass: NullFilesystemStorage },
        RuntimeFilesystemService,
        FormRunService,
    ],
    template: `
        <side-bar></side-bar>
        <rx-router-outlet></rx-router-outlet>
    `,
    styles: `
        :host {
            display: flex;
            height: 100vh;
            overflow: hidden;
        }
        rx-router-outlet {
            flex: 1;
            overflow: auto;
        }
    `,
})
export class AppRoot extends RxElement {
    // Injected purely to force RuntimeFilesystemService into existence (and
    // its onInit() hydration running) as early as possible - nothing else
    // in this component calls it directly, the runtime filesystem is
    // injected independently by whatever component actually needs it.
    @Inject(RuntimeFilesystemService) private readonly filesystem!: RuntimeFilesystemService;

    // Drag library file into studio
    onInit(): void {

        this.addEventListener('dragover', (e) => {
            e.preventDefault();
            this.classList.add('drag-active');
        });

        this.addEventListener('dragleave', () => {
            this.classList.remove('drag-active');
        });

        this.addEventListener('drop', async (e: DragEvent) => {
            e.preventDefault();
            this.classList.remove('drag-active');

            const file = e.dataTransfer?.files[0];
            if (!file || !file.name.endsWith('.json')) return;

            const jsonText = await file.text();
            const libraryData = JSON.parse(jsonText);

            this.filesystem.loadLibrary(libraryData);
        });
    }
}
