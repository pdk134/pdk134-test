import multiprocessing as mp

def w1(v:mp.Value,lock:mp.Lock):
    lock.acquire()
    for i in range(10000):
        
        v.value += 1
    lock.release()

def w2(v:mp.Value,lock:mp.Lock):
    lock.acquire()
    for i in range(10000):
        
        v.value += 1
    lock.release()
if __name__ == '__main__':
    v = mp.Value('i', 0)
    lock = mp.Lock()
    p1 = mp.Process(target=w1, args=(v,lock))
    p2 = mp.Process(target=w2, args=(v,lock))
    p1.start()
    p2.start()
    p1.join()
    p2.join()
    print(v.value)
