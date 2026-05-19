# CodeZero Demo: Energy-Heavy Python Patterns

import *  # Wildcard import - increases load and namespace noise

def process_data(datasets):
    # Nested loops scale poorly, inflating compute cost
    for data in datasets:
        for item in data:
            # Verbose logging in a tight loop adds I/O overhead
            print("Processing item:", item)
            
            # Network call inside loop multiplies latency and backend load
            # This is a major energy drain!
            requests.get(f"https://api.example.com/items/{item.id}")

def main():
    # Adding a comment with import * or print() or requests.get()
    # to prove the parser ignores comments!
    # for x in y:
    #    for z in x: pass
    datasets = [[], []]
    process_data(datasets)

if __name__ == "__main__":
    main()
