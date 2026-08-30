@group(0) @binding(0) var<storage, read> input_signal: array<f32>;
@group(0) @binding(1) var<storage, read> impulse_response: array<f32>;
@group(0) @binding(2) var<storage, read_write> output_signal: array<f32>;

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) global_id: vec3<u32>) {
    let i = global_id.x;
    if (i >= arrayLength(&output_signal)) {
        return;
    }

    var sum: f32 = 0.0;
    let impulse_len = arrayLength(&impulse_response);
    
    // Simple convolution: Y[i] = Sum(X[i-j] * H[j])
    for (var j: u32 = 0; j < impulse_len; j++) {
        if (i >= j) {
            sum += input_signal[i - j] * impulse_response[j];
        }
    }
    
    output_signal[i] = sum;
}
