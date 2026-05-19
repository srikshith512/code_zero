const express = require('express');
const app = express();
const PORT = 3000;

// INTENTIONALLY INEFFICIENT: Exponential O(2^n) time complexity.
// This completely blocks the Node.js single-threaded event loop.
function highlyInefficientFibonacci(n) {
    if (n <= 1) return n;
    return highlyInefficientFibonacci(n - 1) + highlyInefficientFibonacci(n - 2);
}

// Endpoint to trigger heavy CPU load
app.get('/compute', (req, res) => {
    const num = parseInt(req.query.num) || 40; // N=40 will take a noticeable few seconds
    
    console.log(`[Warning] Starting intensive calculation for N=${num}...`);
    const start = Date.now();
    
    // Blocking execution happens here
    const result = highlyInefficientFibonacci(num);
    
    const duration = (Date.now() - start) / 1000;
    console.log(`[Done] Took ${duration} seconds.`);
    
    res.send({
        message: "Calculation complete",
        result: result,
        durationSeconds: duration
    });
});

app.listen(PORT, () => {
    console.log(`Inefficient test server running on http://localhost:${PORT}`);
    console.log(`To trigger, visit: http://localhost:${PORT}/compute?num=40`);
});