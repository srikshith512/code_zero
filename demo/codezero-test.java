import java.util.*;
import java.io.*;

// CodeZero Demo: Energy-Heavy Java Patterns
public class CodeZeroTest {

    public void processData(List<List<String>> datasets) {
        // Nested loops scale poorly, inflating compute cost
        for (List<String> data : datasets) {
            for (String item : data) {
                // Verbose logging in a tight loop adds I/O overhead
                System.out.println("Processing item: " + item);
                
                // Network call inside loop multiplies latency and backend load
                // This is a major energy drain!
                api.fetchItemData(item);
            }
        }
    }

    public static void main(String[] args) {
        // Adding a comment with import .* or System.out.println() or api.fetch()
        // to prove the parser ignores comments!
        // for (int i = 0; i < 10; i++) {
        //    for (int j = 0; j < 10; j++) { }
        // }
        CodeZeroTest test = new CodeZeroTest();
        test.processData(new ArrayList<>());
    }
}
