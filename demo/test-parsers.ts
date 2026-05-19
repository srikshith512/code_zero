import * as vscode from "vscode";
import { analyzeDocument } from "../src/analyzer";
import * as fs from "fs";

// Mock VSCode Document
class MockDocument {
    constructor(public languageId: string, public fileName: string, public text: string) {}
    getText() { return this.text; }
    positionAt(offset: number) {
        let line = 0;
        let character = 0;
        for(let i=0; i<offset; i++) {
            if (this.text[i] === '\n') { line++; character = 0; }
            else { character++; }
        }
        return { line, character, isBefore: () => false, isBeforeOrEqual: () => false, isAfter: () => false, isAfterOrEqual: () => false, isEqual: () => false, compareTo: () => 0, translate: () => this.positionAt(offset), with: () => this.positionAt(offset) } as vscode.Position;
    }
}

// polyfill
(global as any).vscode = {
    Range: class {
        constructor(public start: any, public end: any) {}
    }
};


async function run() {
    console.log("Testing Python Parser...");
    const pythonCode = `
import *

for i in range(10):
    for j in range(10):
        print(i, j)
        fetch("http://test")
`;
    // We ignore comments?
    const pyDoc = new MockDocument("python", "test.py", pythonCode);
    const pyFindings = await analyzeDocument(pyDoc as any);
    console.log("Python Findings:");
    for (const f of pyFindings.findings) {
        console.log("- ", f.id, f.title);
    }
    
    console.log("\\nTesting Java Parser...");
    const javaCode = `
import java.util.*;

class Main {
    void process() {
        for (int i = 0; i < 10; i++) {
            for (int j = 0; j < 10; j++) {
                System.out.println(i + j);
                api.getUser();
            }
        }
    }
}
`;
    const javaDoc = new MockDocument("java", "test.java", javaCode);
    const javaFindings = await analyzeDocument(javaDoc as any);
    console.log("Java Findings:");
    for (const f of javaFindings.findings) {
        console.log("- ", f.id, f.title);
    }
}

run().catch(console.error);
